-- Further forward correction: multiple numbers can share a WABA; only active
-- signup operations are excluded per WABA. No unique WABA connection constraint.
BEGIN;
CREATE INDEX whatsapp_signup_processing_waba ON public.whatsapp_signup_attempts ((context->>'waba_id')) WHERE state='processing';
CREATE OR REPLACE FUNCTION public.claim_whatsapp_signup(p_attempt uuid, p_user uuid, p_account uuid, p_lease uuid, p_hash text DEFAULT NULL, p_context jsonb DEFAULT NULL)
RETURNS SETOF public.whatsapp_signup_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; waba text;
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
  IF a.expires_at <= clock_timestamp() OR (a.lease_until > clock_timestamp() AND a.state='processing') THEN
    RAISE EXCEPTION 'Expired or busy signup' USING ERRCODE='55P03';
  END IF;
  waba := coalesce(a.context,p_context)->>'waba_id';
  IF waba IS NULL THEN RAISE EXCEPTION 'Missing WABA' USING ERRCODE='22023'; END IF;
  -- The advisory lock serializes lease acquisition. The persisted processing
  -- lease excludes other attempts during HTTP work, without holding a DB transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('wa-waba:' || waba,0));
  IF EXISTS (SELECT 1 FROM public.whatsapp_signup_attempts WHERE id<>a.id AND context->>'waba_id'=waba
    AND state='processing' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'WABA signup busy' USING ERRCODE='55P03';
  END IF;
  IF a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Expired signup' USING ERRCODE='55P03'; END IF;
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
  RETURN QUERY UPDATE public.whatsapp_signup_attempts SET state='processing', lease_id=p_lease, lease_until=clock_timestamp()+interval '3 minutes' WHERE id=a.id RETURNING *;
END $$;

CREATE FUNCTION public.assert_whatsapp_signup_lease(p_attempt uuid,p_lease uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts;
BEGIN
  SELECT * INTO a FROM public.whatsapp_signup_attempts WHERE id=p_attempt FOR UPDATE;
  IF NOT FOUND OR p_lease IS NULL OR a.state<>'processing' OR a.lease_id IS DISTINCT FROM p_lease
    OR a.lease_until IS NULL OR a.lease_until<=clock_timestamp() OR a.expires_at<=clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id=a.user_id AND account_id=a.account_id AND account_role IN ('admin','owner')) THEN
    RAISE EXCEPTION 'Stale signup lease' USING ERRCODE='42501';
  END IF;
  -- Also fail closed on any overlapping leases inherited from an older deployment.
  IF EXISTS (SELECT 1 FROM public.whatsapp_signup_attempts WHERE id<>a.id AND context->>'waba_id'=a.context->>'waba_id'
    AND state='processing' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'WABA signup busy' USING ERRCODE='55P03';
  END IF;
END $$;

CREATE FUNCTION public.mark_whatsapp_registration(p_attempt uuid,p_lease uuid,p_encrypted_pin text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  IF p_encrypted_pin IS NULL OR length(p_encrypted_pin)=0 THEN RAISE EXCEPTION 'Missing encrypted PIN' USING ERRCODE='22023'; END IF;
  -- This irreversible intent marker survives lease reclamation and all failures.
  -- Never overwrite it, even when the caller has a newer valid lease.
  UPDATE public.whatsapp_signup_attempts SET pending_registration_pin=p_encrypted_pin,registration_requested_at=clock_timestamp()
    WHERE id=p_attempt AND lease_id=p_lease AND state='processing' AND lease_until>clock_timestamp()
      AND expires_at>clock_timestamp() AND registration_requested_at IS NULL AND pending_access_token IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registration outcome must be reconciled' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION public.release_whatsapp_signup(p_attempt uuid,p_lease uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- Conditional update takes a row lock and rechecks the lease after any wait.
  -- An expired/replaced worker cannot release a current worker's WABA exclusion.
  UPDATE public.whatsapp_signup_attempts SET state='failed',lease_id=NULL,lease_until=NULL
    WHERE id=p_attempt AND state='processing' AND lease_id=p_lease AND lease_until>clock_timestamp();
END $$;
CREATE OR REPLACE FUNCTION public.reserve_whatsapp_signup(p_attempt uuid, p_lease uuid, p_phone text, p_waba text, p_token text, p_metadata jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; c public.whatsapp_config; result uuid;
BEGIN
  SELECT * INTO STRICT a FROM public.whatsapp_signup_attempts WHERE id=p_attempt FOR UPDATE;
  IF a.state <> 'processing' OR a.lease_id IS DISTINCT FROM p_lease OR a.lease_until <= clock_timestamp() OR a.expires_at <= clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id=a.user_id AND account_id=a.account_id AND account_role IN ('admin','owner')) THEN
    RAISE EXCEPTION 'Invalid signup session' USING ERRCODE='42501';
  END IF;
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  IF a.context IS DISTINCT FROM jsonb_build_object('waba_id',p_waba,'phone_number_id',p_phone) THEN
    RAISE EXCEPTION 'Signup context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wa-account:' || a.account_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('wa-waba:' || p_waba,0));
  IF EXISTS (SELECT 1 FROM public.whatsapp_config WHERE waba_id=p_waba AND account_id<>a.account_id) THEN
    RAISE EXCEPTION 'Asset already connected' USING ERRCODE='23505';
  END IF;
  SELECT * INTO c FROM public.whatsapp_config WHERE phone_number_id=p_phone FOR UPDATE;
  -- Lock waits must not let an expired worker write after its earlier check.
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
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
CREATE OR REPLACE FUNCTION public.finish_whatsapp_signup(p_attempt uuid,p_lease uuid,p_registered_at timestamptz,p_subscribed_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; c public.whatsapp_config;
BEGIN
  SELECT * INTO STRICT a FROM public.whatsapp_signup_attempts WHERE id=p_attempt FOR UPDATE;
  IF a.state='complete' THEN RETURN; END IF;
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
  -- Recheck after waiting for the live connection row lock.
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  UPDATE public.whatsapp_config SET access_token=a.pending_access_token,onboarding_metadata=a.pending_metadata,
    registration_pin=coalesce(a.pending_registration_pin,registration_pin),status='connected',connected_at=now(),
    registered_at=p_registered_at,subscribed_apps_at=p_subscribed_at,last_registration_error=NULL,updated_at=now() WHERE id=c.id;
  UPDATE public.whatsapp_signup_attempts SET state='complete',lease_id=NULL,lease_until=NULL,
    pending_access_token=NULL,pending_registration_pin=NULL WHERE id=a.id;
END $$;
REVOKE ALL ON FUNCTION public.assert_whatsapp_signup_lease(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assert_whatsapp_signup_lease(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.mark_whatsapp_registration(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_registration(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.release_whatsapp_signup(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_whatsapp_signup(uuid,uuid) TO service_role;
COMMIT;
