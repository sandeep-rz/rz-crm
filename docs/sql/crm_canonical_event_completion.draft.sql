-- Requires canonical projection/version drafts. Atomic event job commit,
-- guarded by the projected version and current webhook lease.
BEGIN;
CREATE FUNCTION public.crm_complete_canonical_event_v2(
 p_account_id uuid,p_reservation_id uuid,p_event_id uuid,p_attempt integer,
 p_source_version bigint,p_jobs jsonb,p_cancel_timing boolean
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path TO '' AS $$
DECLARE r public.pms_reservations%ROWTYPE; e public.pms_webhook_events%ROWTYPE; j public.automation_trigger_jobs%ROWTYPE; item jsonb; timing jsonb:='[]'::jsonb;
BEGIN
 IF p_source_version IS NULL OR p_source_version<=0 OR jsonb_typeof(p_jobs) IS DISTINCT FROM 'array' OR p_cancel_timing IS NULL THEN RAISE EXCEPTION 'Invalid event completion'; END IF;
 SELECT * INTO r FROM public.pms_reservations WHERE id=p_reservation_id AND account_id=p_account_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reservation scope mismatch'; END IF;
 SELECT * INTO e FROM public.pms_webhook_events WHERE id=p_event_id AND account_id=p_account_id
 AND pms_integration_id=r.pms_integration_id AND pms_property_id=r.pms_property_id FOR UPDATE;
 IF NOT FOUND OR e.status<>'processing' OR e.attempt_count<>p_attempt THEN RAISE EXCEPTION 'Event lease mismatch'; END IF;
 IF r.canonical_source_version IS DISTINCT FROM p_source_version THEN RETURN 'version_changed'; END IF;
 IF r.metadata->>'guest_resolution' IS DISTINCT FROM 'resolved' THEN RETURN 'guest_unresolved'; END IF;
 IF e.payload#>>'{data,source_version}' IS DISTINCT FROM p_source_version::text THEN RETURN 'superseded'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_jobs) LOOP
 j:=jsonb_populate_record(NULL::public.automation_trigger_jobs,item);
 IF j.account_id IS DISTINCT FROM p_account_id OR j.pms_reservation_id IS DISTINCT FROM r.id
 OR NOT EXISTS(SELECT 1 FROM public.automations a WHERE a.id=j.automation_id AND a.account_id=p_account_id AND a.is_active AND a.trigger_type=j.trigger_type)
 THEN RAISE EXCEPTION 'Invalid job scope'; END IF;
 IF j.trigger_type IN ('reservation_confirmed','reservation_updated','reservation_cancelled') THEN
 IF j.pms_webhook_event_id IS DISTINCT FROM e.id OR j.trigger_type IS DISTINCT FROM replace(e.event_type,'.','_') THEN RAISE EXCEPTION 'Invalid event job'; END IF;
 IF j.trigger_type='reservation_confirmed' AND EXISTS(SELECT 1 FROM public.automation_trigger_jobs q WHERE q.account_id=p_account_id AND q.pms_reservation_id=r.id AND q.automation_id=j.automation_id AND q.trigger_type=j.trigger_type) THEN CONTINUE; END IF;
 INSERT INTO public.automation_trigger_jobs(account_id,automation_id,pms_reservation_id,pms_webhook_event_id,trigger_type,occurrence_key,run_at,source_updated_at)
 VALUES(j.account_id,j.automation_id,j.pms_reservation_id,e.id,j.trigger_type,j.occurrence_key,j.run_at,r.updated_at)
 ON CONFLICT(occurrence_key) DO NOTHING;
 ELSIF j.trigger_type IN ('before_checkin','checkin_day','after_checkout') AND j.pms_webhook_event_id IS NULL AND NOT p_cancel_timing THEN
 timing:=timing||jsonb_build_array(item||jsonb_build_object('source_updated_at',r.updated_at));
 ELSE RAISE EXCEPTION 'Invalid scheduled job'; END IF;
 END LOOP;
 IF jsonb_array_length(timing)>0 THEN PERFORM public.upsert_pms_automation_schedule_jobs(timing); END IF;
 IF p_cancel_timing THEN
 UPDATE public.automation_trigger_jobs SET status='cancelled',retryable=false,next_attempt_at=NULL,processing_started_at=NULL,completed_at=now(),last_error='Reservation cancelled.',source_updated_at=r.updated_at
 WHERE account_id=p_account_id AND pms_reservation_id=r.id AND trigger_type IN ('before_checkin','checkin_day','after_checkout') AND status IN ('scheduled','failed');
 END IF;
 UPDATE public.pms_webhook_events SET status='processed',processing_started_at=NULL,processed_at=now(),retryable=false,next_attempt_at=NULL,error_message=NULL WHERE id=e.id;
 RETURN 'processed';
END;
$$;
REVOKE ALL ON FUNCTION public.crm_complete_canonical_event_v2(uuid,uuid,uuid,integer,bigint,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_complete_canonical_event_v2(uuid,uuid,uuid,integer,bigint,jsonb,boolean) TO service_role;
COMMIT;
