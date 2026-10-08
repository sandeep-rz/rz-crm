-- Durable replay protection; connections remain in the canonical whatsapp_config table.
BEGIN;
ALTER TABLE public.whatsapp_config
  ADD COLUMN onboarding_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN registration_pin text;
COMMENT ON COLUMN public.whatsapp_config.registration_pin IS 'AES-256-GCM encrypted generated Embedded Signup registration PIN. Never returned to browsers.';
CREATE TABLE public.whatsapp_signup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  reconnect_id uuid REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','complete','failed')),
  code_hash text UNIQUE,
  context jsonb,
  connection_id uuid REFERENCES public.whatsapp_config(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
ALTER TABLE public.whatsapp_signup_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_signup_attempts FROM anon, authenticated;
GRANT ALL ON public.whatsapp_signup_attempts TO service_role;
CREATE INDEX ON public.whatsapp_signup_attempts (user_id, created_at);

-- Serializes reservations across instances. No external Meta side effects until this succeeds.
CREATE FUNCTION public.reserve_whatsapp_signup(p_attempt uuid, p_phone text, p_waba text, p_token text, p_metadata jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; c public.whatsapp_config; result uuid;
BEGIN
  SELECT * INTO STRICT a FROM public.whatsapp_signup_attempts WHERE id = p_attempt FOR UPDATE;
  IF a.state <> 'processing' OR a.expires_at <= now() OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = a.user_id AND account_id = a.account_id AND account_role IN ('admin', 'owner')) THEN
    RAISE EXCEPTION 'Invalid signup session' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wa-account:' || a.account_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('wa-waba:' || p_waba, 0));
  IF EXISTS (SELECT 1 FROM public.whatsapp_config WHERE waba_id = p_waba AND account_id <> a.account_id) THEN
    RAISE EXCEPTION 'Asset already connected' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO c FROM public.whatsapp_config WHERE phone_number_id = p_phone FOR UPDATE;
  IF c.id IS NOT NULL THEN
    IF c.account_id <> a.account_id OR a.reconnect_id IS DISTINCT FROM c.id OR c.waba_id IS DISTINCT FROM p_waba THEN
      RAISE EXCEPTION 'Existing connection protected' USING ERRCODE = '23505';
    END IF;
    IF EXISTS (SELECT 1 FROM public.whatsapp_signup_attempts WHERE connection_id = c.id AND state = 'processing' AND expires_at > now() AND id <> a.id) THEN
      RAISE EXCEPTION 'Connection busy' USING ERRCODE = '23505';
    END IF;
    result := c.id;
    UPDATE public.whatsapp_config SET access_token = p_token, status = 'disconnected', connected_at = NULL,
      onboarding_metadata = p_metadata, registered_at = NULL, subscribed_apps_at = NULL,
      last_registration_error = 'Embedded Signup setup incomplete. Reconnect to retry.', updated_at = now() WHERE id = result;
  ELSE
    IF a.reconnect_id IS NOT NULL THEN RAISE EXCEPTION 'Reconnect number mismatch' USING ERRCODE = '23505'; END IF;
    INSERT INTO public.whatsapp_config (user_id, account_id, phone_number_id, waba_id, access_token, display_name, status, is_primary, onboarding_metadata)
      VALUES (a.user_id, a.account_id, p_phone, p_waba, p_token, p_metadata->>'display_phone_number', 'disconnected',
        NOT EXISTS (SELECT 1 FROM public.whatsapp_config WHERE account_id = a.account_id AND is_primary), p_metadata)
      RETURNING id INTO result;
  END IF;
  UPDATE public.whatsapp_signup_attempts SET connection_id = result WHERE id = a.id;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.reserve_whatsapp_signup(uuid,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_whatsapp_signup(uuid,text,text,text,jsonb) TO service_role;

CREATE FUNCTION public.finish_whatsapp_signup(p_attempt uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts;
BEGIN
  SELECT * INTO STRICT a FROM public.whatsapp_signup_attempts WHERE id = p_attempt FOR UPDATE;
  IF a.state <> 'processing' OR a.connection_id IS NULL OR a.expires_at <= now() OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = a.user_id AND account_id = a.account_id AND account_role IN ('admin', 'owner')) THEN
    RAISE EXCEPTION 'Invalid signup session' USING ERRCODE = '42501';
  END IF;
  UPDATE public.whatsapp_config SET status = 'connected', connected_at = now(), registered_at = now(),
    subscribed_apps_at = now(), last_registration_error = NULL, updated_at = now()
    WHERE id = a.connection_id AND account_id = a.account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Connection removed'; END IF;
  UPDATE public.whatsapp_signup_attempts SET state = 'complete' WHERE id = a.id;
END $$;
REVOKE ALL ON FUNCTION public.finish_whatsapp_signup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_whatsapp_signup(uuid) TO service_role;
COMMIT;
