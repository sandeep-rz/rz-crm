-- Forward correction for migration 73. Replacement credentials are staged, never
-- applied to a working connection before Meta activation is verified.
BEGIN;
ALTER TABLE public.whatsapp_signup_attempts
  ADD COLUMN pending_access_token text,
  ADD COLUMN pending_metadata jsonb,
  ADD COLUMN pending_registration_pin text,
  ADD COLUMN registration_requested_at timestamptz,
  ADD COLUMN connection_updated_at timestamptz,
  ADD COLUMN lease_id uuid,
  ADD COLUMN lease_until timestamptz;
ALTER TABLE public.whatsapp_signup_attempts ALTER COLUMN expires_at SET DEFAULT now() + interval '24 hours';
-- Existing interactive attempts can finish without the old ten-minute deadline.
UPDATE public.whatsapp_signup_attempts SET expires_at = created_at + interval '24 hours' WHERE state = 'pending';
-- Preserve recoverability of partially completed migration-73 attempts. Their
-- connection already held the candidate token; the old token cannot be reconstructed.
-- Quiesce the old endpoint while applying this migration and deploying the new handler.
UPDATE public.whatsapp_signup_attempts a SET pending_access_token=c.access_token,
  pending_metadata=c.onboarding_metadata,pending_registration_pin=c.registration_pin,
  registration_requested_at=now(),connection_updated_at=c.updated_at,state='failed',expires_at=now()+interval '24 hours'
FROM public.whatsapp_config c WHERE c.id=a.connection_id AND c.account_id=a.account_id
  AND a.state IN ('processing','failed') AND c.onboarding_metadata->>'method'='embedded_signup';
CREATE INDEX whatsapp_signup_attempts_connection ON public.whatsapp_signup_attempts(connection_id) WHERE pending_access_token IS NOT NULL AND state <> 'complete';

CREATE FUNCTION public.claim_whatsapp_signup(p_attempt uuid, p_user uuid, p_account uuid, p_lease uuid, p_hash text DEFAULT NULL, p_context jsonb DEFAULT NULL)
RETURNS SETOF public.whatsapp_signup_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts;
BEGIN
  SELECT * INTO a FROM public.whatsapp_signup_attempts WHERE id=p_attempt AND user_id=p_user AND account_id=p_account FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id=p_user AND account_id=p_account AND account_role IN ('admin','owner')) THEN
    RAISE EXCEPTION 'Invalid signup session' USING ERRCODE='42501';
  END IF;
  IF a.state = 'complete' THEN
    IF (p_hash IS NOT NULL AND p_hash IS DISTINCT FROM a.code_hash) OR (p_context IS NOT NULL AND p_context IS DISTINCT FROM a.context) THEN
      RAISE EXCEPTION 'Signup context mismatch' USING ERRCODE='42501';
    END IF;
    RETURN NEXT a; RETURN;
  END IF;
  IF a.expires_at <= now() OR (a.lease_until > now() AND a.state='processing') THEN
    RAISE EXCEPTION 'Expired or busy signup' USING ERRCODE='55P03';
  END IF;
  IF a.pending_access_token IS NULL THEN
    -- A consumed code with no durable credentials cannot safely be replayed.
    IF a.state <> 'pending' OR p_hash IS NULL OR p_context IS NULL THEN
      RAISE EXCEPTION 'New authorization required' USING ERRCODE='22023';
    END IF;
    UPDATE public.whatsapp_signup_attempts SET code_hash=p_hash, context=p_context WHERE id=a.id;
  ELSIF (p_hash IS NOT NULL AND p_hash IS DISTINCT FROM a.code_hash) OR (p_context IS NOT NULL AND p_context IS DISTINCT FROM a.context) THEN
    RAISE EXCEPTION 'Signup context mismatch' USING ERRCODE='42501';
  END IF;
  -- Longer than the endpoint's 120s maximum. Every later write is fenced by this lease.
  RETURN QUERY UPDATE public.whatsapp_signup_attempts SET state='processing', lease_id=p_lease, lease_until=now()+interval '3 minutes' WHERE id=a.id RETURNING *;
END $$;

DROP FUNCTION public.reserve_whatsapp_signup(uuid,text,text,text,jsonb);
CREATE FUNCTION public.reserve_whatsapp_signup(p_attempt uuid, p_lease uuid, p_phone text, p_waba text, p_token text, p_metadata jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; c public.whatsapp_config; result uuid;
BEGIN
  SELECT * INTO STRICT a FROM public.whatsapp_signup_attempts WHERE id=p_attempt FOR UPDATE;
  IF a.state <> 'processing' OR a.lease_id IS DISTINCT FROM p_lease OR a.lease_until <= now() OR a.expires_at <= now()
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id=a.user_id AND account_id=a.account_id AND account_role IN ('admin','owner')) THEN
    RAISE EXCEPTION 'Invalid signup session' USING ERRCODE='42501';
  END IF;
  IF a.context IS DISTINCT FROM jsonb_build_object('waba_id',p_waba,'phone_number_id',p_phone) THEN
    RAISE EXCEPTION 'Signup context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wa-account:' || a.account_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('wa-waba:' || p_waba,0));
  IF EXISTS (SELECT 1 FROM public.whatsapp_config WHERE waba_id=p_waba AND account_id<>a.account_id) THEN
    RAISE EXCEPTION 'Asset already connected' USING ERRCODE='23505';
  END IF;
  SELECT * INTO c FROM public.whatsapp_config WHERE phone_number_id=p_phone FOR UPDATE;
  IF a.pending_access_token IS NOT NULL THEN
    IF c.id IS DISTINCT FROM a.connection_id OR c.account_id IS DISTINCT FROM a.account_id OR c.waba_id IS DISTINCT FROM p_waba
      OR c.updated_at IS DISTINCT FROM a.connection_updated_at THEN
      RAISE EXCEPTION 'Connection changed during setup' USING ERRCODE='23505';
    END IF;
    RETURN a.connection_id;
  END IF;
  IF c.id IS NOT NULL THEN
    IF c.account_id<>a.account_id OR a.reconnect_id IS DISTINCT FROM c.id OR c.waba_id IS DISTINCT FROM p_waba THEN
      RAISE EXCEPTION 'Existing connection protected' USING ERRCODE='23505';
    END IF;
    IF EXISTS (SELECT 1 FROM public.whatsapp_signup_attempts WHERE connection_id=c.id AND pending_access_token IS NOT NULL AND state<>'complete' AND expires_at>now() AND id<>a.id) THEN
      RAISE EXCEPTION 'Connection has recoverable signup' USING ERRCODE='23505';
    END IF;
    result := c.id;
    -- No live connection fields change here, including its token and timestamps.
  ELSE
    IF a.reconnect_id IS NOT NULL THEN RAISE EXCEPTION 'Reconnect number mismatch' USING ERRCODE='23505'; END IF;
    INSERT INTO public.whatsapp_config(user_id,account_id,phone_number_id,waba_id,access_token,display_name,status,is_primary,onboarding_metadata,updated_at)
      VALUES(a.user_id,a.account_id,p_phone,p_waba,p_token,p_metadata->>'display_phone_number','disconnected',
        NOT EXISTS(SELECT 1 FROM public.whatsapp_config WHERE account_id=a.account_id AND is_primary),p_metadata,now())
      RETURNING * INTO c;
    result := c.id;
  END IF;
  UPDATE public.whatsapp_signup_attempts SET connection_id=result, connection_updated_at=c.updated_at,
    pending_access_token=p_token,pending_metadata=p_metadata,expires_at=now()+interval '24 hours' WHERE id=a.id;
  RETURN result;
END $$;

DROP FUNCTION public.finish_whatsapp_signup(uuid);
CREATE FUNCTION public.finish_whatsapp_signup(p_attempt uuid,p_lease uuid,p_registered_at timestamptz,p_subscribed_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; c public.whatsapp_config;
BEGIN
  SELECT * INTO STRICT a FROM public.whatsapp_signup_attempts WHERE id=p_attempt FOR UPDATE;
  IF a.state='complete' THEN RETURN; END IF;
  IF a.state<>'processing' OR a.lease_id IS DISTINCT FROM p_lease OR a.lease_until<=now() OR a.expires_at<=now() OR a.pending_access_token IS NULL
    OR p_registered_at IS NULL OR p_subscribed_at IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id=a.user_id AND account_id=a.account_id AND account_role IN ('admin','owner')) THEN
    RAISE EXCEPTION 'Invalid signup session' USING ERRCODE='42501';
  END IF;
  SELECT * INTO c FROM public.whatsapp_config WHERE id=a.connection_id AND account_id=a.account_id FOR UPDATE;
  IF NOT FOUND OR c.updated_at IS DISTINCT FROM a.connection_updated_at
    OR c.phone_number_id IS DISTINCT FROM a.context->>'phone_number_id' OR c.waba_id IS DISTINCT FROM a.context->>'waba_id' THEN
    RAISE EXCEPTION 'Connection changed during setup' USING ERRCODE='23505';
  END IF;
  UPDATE public.whatsapp_config SET access_token=a.pending_access_token,onboarding_metadata=a.pending_metadata,
    registration_pin=coalesce(a.pending_registration_pin,registration_pin),status='connected',connected_at=now(),
    registered_at=p_registered_at,subscribed_apps_at=p_subscribed_at,last_registration_error=NULL,updated_at=now() WHERE id=c.id;
  UPDATE public.whatsapp_signup_attempts SET state='complete',lease_id=NULL,lease_until=NULL,
    pending_access_token=NULL,pending_registration_pin=NULL WHERE id=a.id;
END $$;
REVOKE ALL ON FUNCTION public.claim_whatsapp_signup(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reserve_whatsapp_signup(uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_whatsapp_signup(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_signup(uuid,uuid,uuid,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_whatsapp_signup(uuid,uuid,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_whatsapp_signup(uuid,uuid,timestamptz,timestamptz) TO service_role;
COMMIT;
