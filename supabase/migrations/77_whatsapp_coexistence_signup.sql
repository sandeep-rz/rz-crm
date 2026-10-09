BEGIN;
ALTER TABLE public.whatsapp_signup_attempts
  ADD COLUMN onboarding_mode text NOT NULL DEFAULT 'cloud_api' CHECK (onboarding_mode IN ('cloud_api','coexistence')),
  ADD COLUMN completion_mode text CHECK (completion_mode IN ('cloud_api','coexistence')),
  ADD COLUMN signup_completed_at timestamptz;
ALTER TABLE public.whatsapp_config ADD COLUMN coexistence_state jsonb NOT NULL DEFAULT '{}';

-- Preserve the audited lease implementation. Only the service-role wrapper can call it.
ALTER FUNCTION public.claim_whatsapp_signup(uuid,uuid,uuid,uuid,text,jsonb) RENAME TO claim_whatsapp_signup_lease;
REVOKE ALL ON FUNCTION public.claim_whatsapp_signup_lease(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.claim_whatsapp_signup(p_attempt uuid,p_user uuid,p_account uuid,p_lease uuid,p_hash text DEFAULT NULL,p_context jsonb DEFAULT NULL,p_mode text DEFAULT NULL)
RETURNS SETOF public.whatsapp_signup_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; normalized jsonb := p_context;
BEGIN
  SELECT * INTO a FROM public.whatsapp_signup_attempts WHERE id=p_attempt AND user_id=p_user AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid session' USING ERRCODE='42501'; END IF;
  IF p_mode IS NOT NULL AND p_mode NOT IN ('cloud_api','coexistence') THEN RAISE EXCEPTION 'Invalid mode' USING ERRCODE='22023'; END IF;
  -- The persisted choice is server-bound; generic FINISH cannot downgrade it.
  IF a.onboarding_mode='coexistence' THEN p_mode := 'coexistence'; END IF;
  -- The session event is a hint. A verified phone-number-first promotion must
  -- survive replay of the original FINISH event without downgrading its mode.
  IF a.completion_mode IS NOT NULL AND p_mode IS NOT NULL AND a.completion_mode<>p_mode
    AND NOT (a.completion_mode='coexistence' AND a.pending_metadata->>'onboarding_mode' IS NOT DISTINCT FROM 'coexistence') THEN
    RAISE EXCEPTION 'Completion mode mismatch' USING ERRCODE='42501';
  END IF;
  -- On recovery/replay, the resolved phone must not change, even if the session
  -- event originally contained only a WABA. Preserve strict WABA/code matching.
  IF p_mode='coexistence' AND p_context->>'phone_number_id' IS NULL AND a.context->>'phone_number_id' IS NOT NULL THEN
    normalized := p_context || jsonb_build_object('phone_number_id',a.context->>'phone_number_id');
  END IF;
  PERFORM public.claim_whatsapp_signup_lease(p_attempt,p_user,p_account,p_lease,p_hash,normalized);
  UPDATE public.whatsapp_signup_attempts SET completion_mode=coalesce(completion_mode,p_mode,'cloud_api'),
    onboarding_mode=coalesce(completion_mode,p_mode,'cloud_api'),
    signup_completed_at=coalesce(signup_completed_at,clock_timestamp()) WHERE id=p_attempt;
  RETURN QUERY SELECT * FROM public.whatsapp_signup_attempts WHERE id=p_attempt;
END $$;
CREATE FUNCTION public.resolve_whatsapp_signup_phone(p_attempt uuid,p_lease uuid,p_phone text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  IF p_phone !~ '^\d{1,30}$' THEN RAISE EXCEPTION 'Invalid phone' USING ERRCODE='22023'; END IF;
  UPDATE public.whatsapp_signup_attempts SET context=context || jsonb_build_object('phone_number_id',p_phone)
    WHERE id=p_attempt AND completion_mode='coexistence' AND context->>'phone_number_id' IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phone selection protected' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION public.mark_whatsapp_signup_coexistence(p_attempt uuid,p_lease uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  UPDATE public.whatsapp_signup_attempts SET onboarding_mode='coexistence',completion_mode='coexistence',
    pending_metadata=pending_metadata || '{"onboarding_mode":"coexistence"}'
    WHERE id=p_attempt AND pending_access_token IS NOT NULL AND registration_requested_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registration intent protected' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.mark_whatsapp_signup_coexistence(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_signup_coexistence(uuid,uuid) TO service_role;

-- Add the mode gate directly to the existing guarded registration function.
CREATE OR REPLACE FUNCTION public.mark_whatsapp_registration(p_attempt uuid,p_lease uuid,p_encrypted_pin text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  IF EXISTS (SELECT 1 FROM public.whatsapp_signup_attempts WHERE id=p_attempt AND completion_mode='coexistence') THEN
    RAISE EXCEPTION 'Coexistence numbers cannot be registered' USING ERRCODE='42501';
  END IF;
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
REVOKE ALL ON FUNCTION public.mark_whatsapp_registration(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_registration(uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_whatsapp_signup(p_attempt uuid,p_lease uuid,p_registered_at timestamptz,p_subscribed_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; c public.whatsapp_config;
BEGIN
  SELECT * INTO STRICT a FROM public.whatsapp_signup_attempts WHERE id=p_attempt FOR UPDATE;
  IF a.state='complete' THEN RETURN; END IF;
  IF coalesce(a.pending_metadata->>'onboarding_mode','cloud_api') IS DISTINCT FROM coalesce(a.completion_mode,'cloud_api') THEN
    RAISE EXCEPTION 'Staged onboarding mode mismatch' USING ERRCODE='42501';
  END IF;
  IF a.state<>'processing' OR a.lease_id IS DISTINCT FROM p_lease OR a.lease_until<=clock_timestamp() OR a.expires_at<=clock_timestamp() OR a.pending_access_token IS NULL
    OR p_registered_at IS NULL OR p_subscribed_at IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id=a.user_id AND account_id=a.account_id AND account_role IN ('admin','owner')) THEN
    RAISE EXCEPTION 'Invalid signup session' USING ERRCODE='42501';
  END IF;
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  SELECT * INTO c FROM public.whatsapp_config WHERE id=a.connection_id AND account_id=a.account_id FOR UPDATE;
  IF NOT FOUND OR c.updated_at IS DISTINCT FROM a.connection_updated_at
    OR c.phone_number_id IS DISTINCT FROM a.context->>'phone_number_id' OR c.waba_id IS DISTINCT FROM a.context->>'waba_id' THEN
    RAISE EXCEPTION 'Connection changed during setup' USING ERRCODE='23505';
  END IF;
  IF a.pending_metadata->>'onboarding_mode'='coexistence' AND (c.coexistence_state->>'lifecycle_at')::timestamptz > a.signup_completed_at
    AND c.coexistence_state->>'lifecycle_event' IN ('PARTNER_REMOVED','ACCOUNT_OFFBOARDED') THEN
    RAISE EXCEPTION 'Connection offboarded during signup' USING ERRCODE='23505';
  END IF;
  -- Recheck after waiting for the live connection row lock.
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  UPDATE public.whatsapp_config SET access_token=a.pending_access_token,onboarding_metadata=a.pending_metadata,
    registration_pin=coalesce(a.pending_registration_pin,registration_pin),status='connected',connected_at=now(),
    registered_at=p_registered_at,subscribed_apps_at=p_subscribed_at,last_registration_error=NULL,updated_at=now() WHERE id=c.id;
  IF a.pending_metadata->>'onboarding_mode'='coexistence' THEN
    UPDATE public.whatsapp_config SET onboarding_metadata=onboarding_metadata || '{"is_on_biz_app":true,"platform_type":"CLOUD_API"}', coexistence_state=CASE WHEN coexistence_state->>'lifecycle_event'='PARTNER_REMOVED'
        AND (coexistence_state->>'lifecycle_at')::timestamptz<a.signup_completed_at THEN
        jsonb_build_object('onboarded_at',a.signup_completed_at)
      ELSE coexistence_state || jsonb_build_object('onboarded_at',coalesce(coexistence_state->>'onboarded_at',a.signup_completed_at::text)) END
      WHERE id=a.connection_id AND account_id=a.account_id;
  END IF;
  UPDATE public.whatsapp_signup_attempts SET state='complete',lease_id=NULL,lease_until=NULL,
    pending_access_token=NULL,pending_registration_pin=NULL WHERE id=a.id;
END $$;

CREATE FUNCTION public.begin_whatsapp_coexistence_sync(p_connection uuid,p_type text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.whatsapp_config; at_time timestamptz;
BEGIN
  IF p_type NOT IN ('history','smb_app_state_sync') THEN RAISE EXCEPTION 'Invalid sync type' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT c FROM public.whatsapp_config WHERE id=p_connection FOR UPDATE;
  IF c.status<>'connected' OR c.onboarding_metadata->>'onboarding_mode' IS DISTINCT FROM 'coexistence' THEN RETURN false; END IF;
  IF c.coexistence_state ? p_type THEN RETURN false; END IF;
  at_time := (c.coexistence_state->>'onboarded_at')::timestamptz;
  IF at_time IS NULL OR at_time+interval '24 hours'<=clock_timestamp() THEN
    UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,ARRAY[p_type],'{"state":"deadline_expired"}') WHERE id=p_connection;
    RETURN false;
  END IF;
  UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,ARRAY[p_type],jsonb_build_object('state','unconfirmed','requested_at',clock_timestamp())) WHERE id=p_connection;
  RETURN true;
END $$;
CREATE FUNCTION public.accept_whatsapp_coexistence_sync(p_connection uuid,p_type text,p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_type NOT IN ('history','smb_app_state_sync') OR nullif(p_request_id,'') IS NULL THEN RAISE EXCEPTION 'Invalid acceptance' USING ERRCODE='22023'; END IF;
  UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,ARRAY[p_type],
    coalesce(coexistence_state->p_type,'{}') || jsonb_build_object('state','accepted','request_id',p_request_id))
    WHERE id=p_connection AND coexistence_state->p_type->>'state'='unconfirmed';
  -- A webhook may already have advanced sync to completed/declined. Save the
  -- support request ID without regressing that terminal state.
  IF NOT FOUND THEN
    UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,ARRAY[p_type,'request_id'],to_jsonb(p_request_id))
      WHERE id=p_connection AND coexistence_state ? p_type;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.claim_whatsapp_signup(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.resolve_whatsapp_signup_phone(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_whatsapp_signup(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.begin_whatsapp_coexistence_sync(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.accept_whatsapp_coexistence_sync(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_signup(uuid,uuid,uuid,uuid,text,jsonb,text),public.resolve_whatsapp_signup_phone(uuid,uuid,text),public.finish_whatsapp_signup(uuid,uuid,timestamptz,timestamptz),public.begin_whatsapp_coexistence_sync(uuid,text),public.accept_whatsapp_coexistence_sync(uuid,text,text) TO service_role;
COMMIT;
