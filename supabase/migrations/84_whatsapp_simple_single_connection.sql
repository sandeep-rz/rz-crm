BEGIN;
-- Temporary product policy; the existing multi-number infrastructure stays intact.
CREATE FUNCTION public.assert_whatsapp_connection_slot(p_account uuid,p_existing uuid DEFAULT NULL,p_phone text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('wa-account:'||p_account::text,0));
 -- Existing connections remain maintainable, including legacy workspaces
 -- that already had multiple numbers before this temporary product policy.
 IF EXISTS(SELECT 1 FROM public.whatsapp_config WHERE account_id=p_account
   AND (id=p_existing OR (p_phone IS NOT NULL AND phone_number_id=p_phone))) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM public.whatsapp_config WHERE account_id=p_account) THEN
  RAISE EXCEPTION 'This workspace already has a WhatsApp connection' USING ERRCODE='23514';
 END IF;
END $$;
CREATE FUNCTION public.enforce_one_whatsapp_connection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id THEN RETURN NEW; END IF;
 PERFORM public.assert_whatsapp_connection_slot(NEW.account_id,NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER enforce_one_whatsapp_connection BEFORE INSERT OR UPDATE OF account_id ON public.whatsapp_config
 FOR EACH ROW EXECUTE FUNCTION public.enforce_one_whatsapp_connection();
REVOKE ALL ON FUNCTION public.enforce_one_whatsapp_connection() FROM PUBLIC,anon,authenticated;

-- No user-facing resume/discard lifecycle. Remove abandoned attempts and their
-- staged credentials. Keep only an uncertain registration's minimal tombstone.
CREATE FUNCTION public.clear_unfinished_whatsapp_signup(p_attempt uuid,p_user uuid,p_account uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.whatsapp_signup_attempts;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_user AND account_id=p_account AND account_role IN ('admin','owner')) THEN
  RAISE EXCEPTION 'Invalid setup owner' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wa-account:'||p_account::text,0));
 FOR a IN SELECT * FROM public.whatsapp_signup_attempts WHERE user_id=p_user AND account_id=p_account
   AND (p_attempt IS NULL OR id=p_attempt) AND state<>'complete'
   AND NOT (state='processing' AND coalesce(lease_until>clock_timestamp(),false)) FOR UPDATE SKIP LOCKED LOOP
  -- Never delete a working connection or interrupt an active activation.
  IF a.reconnect_id IS NULL AND a.connection_id IS NOT NULL THEN
   DELETE FROM public.whatsapp_config c WHERE c.id=a.connection_id AND c.account_id=p_account
    AND c.connected_at IS NULL AND c.status='disconnected' AND c.onboarding_metadata->>'method'='embedded_signup'
    AND NOT EXISTS(SELECT 1 FROM public.whatsapp_signup_attempts other WHERE other.id<>a.id
      AND other.connection_id=c.id AND other.state='processing' AND other.lease_until>clock_timestamp());
  END IF;
  IF a.registration_requested_at IS NULL THEN
   DELETE FROM public.whatsapp_signup_attempts WHERE id=a.id;
  ELSE
   UPDATE public.whatsapp_signup_attempts SET discarded_at=clock_timestamp(),expires_at=clock_timestamp(),state='failed',
    lease_id=NULL,lease_until=NULL,authorization_token=NULL,authorization_lease=NULL,pending_access_token=NULL,
    pending_registration_pin=NULL,pending_metadata=NULL,connection_updated_at=NULL
    WHERE id=a.id;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.assert_whatsapp_connection_slot(uuid,uuid,text), public.clear_unfinished_whatsapp_signup(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assert_whatsapp_connection_slot(uuid,uuid,text), public.clear_unfinished_whatsapp_signup(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.maintain_whatsapp_runtime() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE stale record;
BEGIN
 FOR stale IN SELECT a.id,a.user_id,a.account_id FROM public.whatsapp_signup_attempts a
  WHERE a.state<>'complete' AND (a.expires_at<clock_timestamp() OR a.state='failed'
      OR (a.state='processing' AND (a.lease_until IS NULL OR a.lease_until<=clock_timestamp())))
    AND (a.discarded_at IS NULL OR a.authorization_token IS NOT NULL OR a.pending_access_token IS NOT NULL OR a.pending_registration_pin IS NOT NULL)
    AND EXISTS(SELECT 1 FROM public.profiles WHERE user_id=a.user_id AND account_id=a.account_id AND account_role IN ('admin','owner')) LOOP
  PERFORM public.clear_unfinished_whatsapp_signup(stale.id,stale.user_id,stale.account_id);
 END LOOP;
 UPDATE public.whatsapp_signup_attempts SET authorization_token=NULL,pending_access_token=NULL,pending_registration_pin=NULL WHERE expires_at<clock_timestamp() AND (authorization_token IS NOT NULL OR pending_access_token IS NOT NULL OR pending_registration_pin IS NOT NULL);
 DELETE FROM public.whatsapp_signup_attempts WHERE expires_at<clock_timestamp()-interval '30 days' AND registration_requested_at IS NULL AND state<>'processing';
 UPDATE public.whatsapp_coexistence_events SET payload=NULL,records='[]',attempts=10,last_error='payload_retention_expired' WHERE event_kind='delivery' AND processed_at IS NULL AND created_at<clock_timestamp()-interval '30 days';
 DELETE FROM public.whatsapp_coexistence_events WHERE processed_at<clock_timestamp()-interval '30 days';
 DELETE FROM public.whatsapp_send_budgets WHERE next_send_at<clock_timestamp()-interval '1 day';
END $$;

-- Remove existing resumable setups without affecting active work or connections.
DO $$ DECLARE owner record; BEGIN
 FOR owner IN SELECT DISTINCT a.user_id,a.account_id FROM public.whatsapp_signup_attempts a JOIN public.profiles p
   ON p.user_id=a.user_id AND p.account_id=a.account_id WHERE a.state<>'complete' AND p.account_role IN ('admin','owner') LOOP
  PERFORM public.clear_unfinished_whatsapp_signup(NULL,owner.user_id,owner.account_id);
 END LOOP;
END $$;
COMMIT;
