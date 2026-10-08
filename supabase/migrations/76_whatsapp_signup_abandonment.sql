-- Explicit abandonment affects only the attempt ledger, never whatsapp_config.
BEGIN;
ALTER TABLE public.whatsapp_signup_attempts ADD COLUMN discarded_at timestamptz;

CREATE FUNCTION public.discard_whatsapp_signup(p_attempt uuid,p_user uuid,p_account uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts;
BEGIN
  SELECT * INTO a FROM public.whatsapp_signup_attempts WHERE id=p_attempt AND user_id=p_user AND account_id=p_account FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id=p_user AND account_id=p_account AND account_role IN ('admin','owner')) THEN
    RAISE EXCEPTION 'Invalid signup session' USING ERRCODE='42501';
  END IF;
  IF a.discarded_at IS NOT NULL THEN RETURN; END IF;
  IF a.state='complete' OR (a.state='processing' AND a.lease_until>clock_timestamp()) THEN
    RAISE EXCEPTION 'Completed or active signup cannot be discarded' USING ERRCODE='55P03';
  END IF;
  -- Retain context and registration intent as a safety tombstone. Revoke recovery
  -- and erase staged credentials, without touching a connection or Meta assets.
  UPDATE public.whatsapp_signup_attempts SET discarded_at=clock_timestamp(),expires_at=clock_timestamp(),
    state='failed',lease_id=NULL,lease_until=NULL,pending_access_token=NULL,pending_registration_pin=NULL,pending_metadata=NULL
    WHERE id=a.id;
END $$;

CREATE OR REPLACE FUNCTION public.mark_whatsapp_registration(p_attempt uuid,p_lease uuid,p_encrypted_pin text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  IF p_encrypted_pin IS NULL OR length(p_encrypted_pin)=0 THEN RAISE EXCEPTION 'Missing encrypted PIN' USING ERRCODE='22023'; END IF;
  -- Abandonment cannot erase an uncertain external registration. The backend
  -- can still finish a new signup when Meta verifies the number is CONNECTED,
  -- but must never blindly submit another registration for this number.
  IF EXISTS (SELECT 1 FROM public.whatsapp_signup_attempts old
    JOIN public.whatsapp_signup_attempts current ON current.id=p_attempt
    WHERE old.id<>current.id AND old.discarded_at IS NOT NULL AND old.registration_requested_at IS NOT NULL
      AND old.context->>'phone_number_id'=current.context->>'phone_number_id'
      AND old.context->>'waba_id'=current.context->>'waba_id') THEN
    RAISE EXCEPTION 'Discarded registration outcome must be verified in Meta' USING ERRCODE='42501';
  END IF;
  UPDATE public.whatsapp_signup_attempts SET pending_registration_pin=p_encrypted_pin,registration_requested_at=clock_timestamp()
    WHERE id=p_attempt AND lease_id=p_lease AND state='processing' AND lease_until>clock_timestamp()
      AND expires_at>clock_timestamp() AND registration_requested_at IS NULL AND pending_access_token IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registration outcome must be reconciled' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.discard_whatsapp_signup(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.discard_whatsapp_signup(uuid,uuid,uuid) TO service_role;
COMMIT;
