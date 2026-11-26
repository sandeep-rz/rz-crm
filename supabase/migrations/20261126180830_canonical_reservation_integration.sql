-- Class E integration RPCs. Manual application only; apply after migration 94.
BEGIN;
ALTER TABLE public.pms_reservations ADD COLUMN canonical_source_version bigint
 CHECK (canonical_source_version IS NULL OR canonical_source_version > 0);

-- Class E. Authoritative aliases come only from the authenticated PMS reader.
ALTER TABLE public.pms_reservations ADD COLUMN canonical_reservation_id uuid;
ALTER TABLE public.pms_reservations ADD CONSTRAINT pms_canonical_same_account
 FOREIGN KEY(canonical_reservation_id,account_id) REFERENCES public.pms_reservations(id,account_id);
ALTER TABLE public.pms_reservations ADD CONSTRAINT pms_canonical_not_self CHECK(canonical_reservation_id IS DISTINCT FROM id);
CREATE INDEX pms_reservations_canonical_history ON public.pms_reservations(canonical_reservation_id) WHERE canonical_reservation_id IS NOT NULL;
-- Retain original projection and job state before rekey/cancellation, including
-- prior failure diagnostics. This is service-only history, not a contact merge.
CREATE TABLE public.crm_canonical_reconciliation_history (
 account_id uuid NOT NULL REFERENCES public.accounts(id),
 reservation_id uuid NOT NULL REFERENCES public.pms_reservations(id),
 canonical_reservation_id uuid NOT NULL REFERENCES public.pms_reservations(id),
 previous_reservation jsonb NOT NULL,
 previous_jobs jsonb NOT NULL,
 reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,reservation_id)
);
ALTER TABLE public.crm_canonical_reconciliation_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_canonical_reconciliation_history FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.crm_canonical_reconciliation_history TO service_role;

CREATE FUNCTION public.crm_reconcile_pms_reservation_v2(
 p_account_id uuid,p_integration_id uuid,p_property_id uuid,p_parent_id text,p_verified_child_ids text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE winner uuid; ids uuid[];
BEGIN
 IF p_parent_id IS NULL OR btrim(p_parent_id)='' OR cardinality(p_verified_child_ids)<1
 OR p_verified_child_ids IS NULL OR array_position(p_verified_child_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Invalid aliases'; END IF;
 PERFORM 1 FROM public.pms_integrations WHERE id=p_integration_id AND account_id=p_account_id AND status='connected' FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.pms_properties WHERE id=p_property_id AND account_id=p_account_id
 AND pms_integration_id=p_integration_id AND status='active') THEN RAISE EXCEPTION 'Invalid integration/property'; END IF;
 PERFORM id FROM public.pms_reservations WHERE pms_integration_id=p_integration_id
 AND (external_reservation_id=p_parent_id OR external_reservation_id=ANY(p_verified_child_ids)) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.pms_reservations WHERE pms_integration_id=p_integration_id
 AND (external_reservation_id=p_parent_id OR external_reservation_id=ANY(p_verified_child_ids))
 AND (account_id<>p_account_id OR pms_property_id<>p_property_id)) THEN RAISE EXCEPTION 'Alias scope mismatch'; END IF;
 SELECT id INTO winner FROM public.pms_reservations WHERE pms_integration_id=p_integration_id
 AND (external_reservation_id=p_parent_id OR external_reservation_id=ANY(p_verified_child_ids))
 ORDER BY (external_reservation_id=p_parent_id) DESC,created_at,id LIMIT 1;
 IF winner IS NULL THEN RETURN jsonb_build_object('status','insert'); END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM public.pms_reservations WHERE pms_integration_id=p_integration_id
 AND (external_reservation_id=p_parent_id OR external_reservation_id=ANY(p_verified_child_ids));
 IF EXISTS(SELECT 1 FROM public.pms_reservations WHERE id=ANY(ids) AND canonical_reservation_id IS NOT NULL AND canonical_reservation_id<>winner)
 THEN RAISE EXCEPTION 'Alias already assigned to another parent'; END IF;
 IF EXISTS(SELECT 1 FROM public.pms_reservations WHERE id=ANY(ids) AND external_reservation_id<>p_parent_id AND canonical_reservation_id IS NULL) THEN
   INSERT INTO public.crm_canonical_reconciliation_history(account_id,reservation_id,canonical_reservation_id,previous_reservation,previous_jobs)
   SELECT p_account_id,r.id,winner,to_jsonb(r),coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id)
     FROM public.automation_trigger_jobs j WHERE j.pms_reservation_id=r.id AND j.account_id=p_account_id),'[]'::jsonb)
   FROM public.pms_reservations r WHERE r.id=ANY(ids)
   ON CONFLICT(account_id,reservation_id) DO NOTHING;
 END IF;
 -- No reservation/contact/job/log is removed or reassigned. Save original external identity once.
 UPDATE public.pms_reservations SET metadata=metadata||jsonb_build_object('canonical_previous_external_id',external_reservation_id),
 external_reservation_id=p_parent_id WHERE id=winner AND external_reservation_id<>p_parent_id;
 UPDATE public.pms_reservations SET canonical_reservation_id=winner
 WHERE id=ANY(ids) AND id<>winner AND canonical_reservation_id IS NULL;
 UPDATE public.pms_reservations SET metadata=metadata||jsonb_build_object('canonical_identity_pending',true)
 WHERE id=winner AND metadata->>'source_type' IS DISTINCT FROM 'pms_reservations';
 -- In-flight executions must be drained before cutover. Pending duplicate room jobs
 -- remain auditable; canonical timing scheduling owns future work.
 UPDATE public.automation_trigger_jobs SET status='cancelled',retryable=false,next_attempt_at=NULL,
 completed_at=clock_timestamp(),last_error='Historical room projection retained; canonical reservation owns future scheduling.'
 WHERE pms_reservation_id=ANY(ids) AND pms_reservation_id<>winner AND status IN ('scheduled','failed');
 RETURN jsonb_build_object('status','reconciled','id',winner,'preserved_ids',ids);
END;
$$;
REVOKE ALL ON FUNCTION public.crm_reconcile_pms_reservation_v2(uuid,uuid,uuid,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_reconcile_pms_reservation_v2(uuid,uuid,uuid,text,text[]) TO service_role;

CREATE FUNCTION public.crm_save_canonical_projection_v2(
 p_row jsonb,p_source_version bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE r public.pms_reservations%ROWTYPE; old public.pms_reservations%ROWTYPE;
BEGIN
 r:=jsonb_populate_record(NULL::public.pms_reservations,p_row);
 IF p_source_version IS NULL OR p_source_version<=0 OR r.account_id IS NULL
 OR r.pms_integration_id IS NULL OR r.pms_property_id IS NULL OR r.external_reservation_id IS NULL
 OR r.metadata->>'source_type' IS DISTINCT FROM 'pms_reservations'
 THEN RAISE EXCEPTION 'Invalid canonical projection'; END IF;
 PERFORM 1 FROM public.pms_integrations WHERE id=r.pms_integration_id AND account_id=r.account_id
 AND status='connected' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Integration mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.pms_properties WHERE id=r.pms_property_id AND account_id=r.account_id
 AND pms_integration_id=r.pms_integration_id AND status='active') THEN RAISE EXCEPTION 'Property mismatch'; END IF;
 IF r.contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=r.contact_id AND account_id=r.account_id)
 THEN RAISE EXCEPTION 'Contact mismatch'; END IF;
 SELECT * INTO old FROM public.pms_reservations WHERE pms_integration_id=r.pms_integration_id
 AND external_reservation_id=r.external_reservation_id FOR UPDATE;
 IF FOUND THEN
 IF old.canonical_reservation_id IS NOT NULL THEN RAISE EXCEPTION 'Historical alias is immutable'; END IF;
 IF old.account_id<>r.account_id OR old.pms_property_id<>r.pms_property_id THEN RAISE EXCEPTION 'Reservation scope mismatch'; END IF;
 IF old.canonical_source_version IS NOT NULL AND old.canonical_source_version>=p_source_version
 THEN RETURN jsonb_build_object('id',old.id,'skippedStale',true); END IF;
 UPDATE public.pms_reservations SET contact_id=CASE WHEN r.metadata->>'guest_resolution'='unresolved' THEN old.contact_id ELSE r.contact_id END,
 external_guest_id=r.external_guest_id,external_listing_id=r.external_listing_id,reservation_code=r.reservation_code,
 status=r.status,provider_status=r.provider_status,check_in=r.check_in,check_out=r.check_out,
 adults=r.adults,children=r.children,infants=r.infants,pets=r.pets,occupancy_total=r.occupancy_total,
 channel_code=r.channel_code,channel_name=r.channel_name,total_amount=r.total_amount,paid_amount=r.paid_amount,
 balance_due=r.balance_due,currency=r.currency,payment_status=r.payment_status,
 external_created_at=r.external_created_at,external_updated_at=r.external_updated_at,last_synced_at=r.last_synced_at,
 metadata=(old.metadata-'canonical_identity_pending')||r.metadata,canonical_source_version=p_source_version WHERE id=old.id;
 RETURN jsonb_build_object('id',old.id,'skippedStale',false);
 END IF;
 INSERT INTO public.pms_reservations(account_id,pms_integration_id,pms_property_id,contact_id,external_reservation_id,
 external_guest_id,external_listing_id,reservation_code,status,provider_status,check_in,check_out,adults,children,infants,pets,occupancy_total,
 channel_code,channel_name,total_amount,paid_amount,balance_due,currency,payment_status,external_created_at,external_updated_at,last_synced_at,metadata,canonical_source_version)
 VALUES(r.account_id,r.pms_integration_id,r.pms_property_id,r.contact_id,r.external_reservation_id,
 r.external_guest_id,r.external_listing_id,r.reservation_code,r.status,r.provider_status,r.check_in,r.check_out,r.adults,r.children,r.infants,r.pets,r.occupancy_total,
 r.channel_code,r.channel_name,r.total_amount,r.paid_amount,r.balance_due,r.currency,r.payment_status,r.external_created_at,r.external_updated_at,r.last_synced_at,r.metadata,p_source_version)
 RETURNING id INTO r.id;
 RETURN jsonb_build_object('id',r.id,'skippedStale',false);
END;
$$;
REVOKE ALL ON FUNCTION public.crm_save_canonical_projection_v2(jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_save_canonical_projection_v2(jsonb,bigint) TO service_role;
CREATE FUNCTION public.crm_complete_canonical_event_v2(
 p_account_id uuid,p_reservation_id uuid,p_event_id uuid,p_attempt integer,
 p_source_version bigint,p_jobs jsonb,p_cancel_timing boolean,p_plan_updated_at timestamptz,p_plan_automations jsonb,p_plan_timezone text
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE r public.pms_reservations%ROWTYPE; e public.pms_webhook_events%ROWTYPE; j public.automation_trigger_jobs%ROWTYPE; item jsonb;
BEGIN
 IF p_source_version IS NULL OR p_source_version<=0 OR jsonb_typeof(p_jobs) IS DISTINCT FROM 'array' OR p_cancel_timing IS NULL THEN RAISE EXCEPTION 'Invalid event completion'; END IF;
 SELECT * INTO r FROM public.pms_reservations WHERE id=p_reservation_id AND account_id=p_account_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reservation scope mismatch'; END IF;
 SELECT * INTO e FROM public.pms_webhook_events WHERE id=p_event_id AND account_id=p_account_id
 AND pms_integration_id=r.pms_integration_id AND pms_property_id=r.pms_property_id FOR UPDATE;
 IF NOT FOUND OR e.status<>'processing' OR e.attempt_count<>p_attempt THEN RAISE EXCEPTION 'Event lease mismatch'; END IF;
 IF r.canonical_source_version IS DISTINCT FROM p_source_version OR r.updated_at IS DISTINCT FROM p_plan_updated_at THEN RETURN 'version_changed'; END IF;
 -- Serialize configuration edits while validating the plan generated by the existing scheduler.
 PERFORM 1 FROM public.pms_properties WHERE id=r.pms_property_id AND account_id=p_account_id
 AND pms_integration_id=r.pms_integration_id AND status='active' AND timezone IS NOT DISTINCT FROM p_plan_timezone FOR SHARE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.pms_integrations WHERE id=r.pms_integration_id AND account_id=p_account_id AND status='connected') THEN RETURN 'version_changed'; END IF;
 PERFORM id FROM public.automations WHERE account_id=p_account_id ORDER BY id FOR SHARE;
 IF jsonb_typeof(p_plan_automations) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid automation plan'; END IF;
 IF EXISTS(SELECT 1 FROM public.automations a FULL JOIN
   jsonb_to_recordset(p_plan_automations) AS expected(id uuid,updated_at timestamptz)
   ON expected.id=a.id AND a.account_id=p_account_id
   AND a.is_active AND a.trigger_type IN ('reservation_confirmed','reservation_updated','reservation_cancelled','before_checkin','checkin_day','after_checkout')
   WHERE ((a.account_id=p_account_id AND a.is_active AND a.trigger_type IN ('reservation_confirmed','reservation_updated','reservation_cancelled','before_checkin','checkin_day','after_checkout')) OR expected.id IS NOT NULL)
   AND (expected.id IS NULL OR a.id IS NULL OR a.updated_at IS DISTINCT FROM expected.updated_at)) THEN RETURN 'version_changed'; END IF;
 IF r.metadata->>'guest_resolution' IS DISTINCT FROM 'resolved' THEN RETURN 'guest_unresolved'; END IF;
 IF e.payload#>>'{data,source_version}' IS DISTINCT FROM p_source_version::text
 OR e.payload#>>'{source,type}' IS DISTINCT FROM 'pms_reservations'
 OR e.external_resource_id IS DISTINCT FROM r.external_reservation_id THEN RETURN 'superseded'; END IF;
 IF (e.event_type='reservation.cancelled') IS DISTINCT FROM (r.status='cancelled') THEN RETURN 'superseded'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_jobs) LOOP
 j:=jsonb_populate_record(NULL::public.automation_trigger_jobs,item);
 IF j.account_id IS DISTINCT FROM p_account_id OR j.pms_reservation_id IS DISTINCT FROM r.id
 OR NOT EXISTS(SELECT 1 FROM public.automations a WHERE a.id=j.automation_id AND a.account_id=p_account_id AND a.is_active AND a.trigger_type=j.trigger_type)
 THEN RAISE EXCEPTION 'Invalid job scope'; END IF;
 IF j.trigger_type IN ('reservation_confirmed','reservation_updated','reservation_cancelled') THEN
 IF j.pms_webhook_event_id IS DISTINCT FROM e.id OR j.trigger_type IS DISTINCT FROM replace(e.event_type,'.','_') THEN RAISE EXCEPTION 'Invalid event job'; END IF;
 IF j.trigger_type='reservation_confirmed' AND EXISTS(SELECT 1 FROM public.automation_trigger_jobs q WHERE q.account_id=p_account_id AND (q.pms_reservation_id=r.id OR q.pms_reservation_id IN (SELECT id FROM public.pms_reservations WHERE canonical_reservation_id=r.id)) AND q.automation_id=j.automation_id AND q.trigger_type=j.trigger_type) THEN CONTINUE; END IF;
 INSERT INTO public.automation_trigger_jobs(account_id,automation_id,pms_reservation_id,pms_webhook_event_id,trigger_type,occurrence_key,run_at,source_updated_at)
 VALUES(j.account_id,j.automation_id,j.pms_reservation_id,e.id,j.trigger_type,j.occurrence_key,j.run_at,r.updated_at)
 ON CONFLICT(occurrence_key) DO NOTHING;
 ELSIF j.trigger_type IN ('before_checkin','checkin_day','after_checkout') AND j.pms_webhook_event_id IS NULL AND NOT p_cancel_timing THEN
 PERFORM public.upsert_pms_automation_schedule_jobs(jsonb_build_array(item||jsonb_build_object('source_updated_at',r.updated_at)));
 ELSE RAISE EXCEPTION 'Invalid scheduled job'; END IF;
 END LOOP;
 IF p_cancel_timing THEN
 UPDATE public.automation_trigger_jobs SET status='cancelled',retryable=false,next_attempt_at=NULL,processing_started_at=NULL,completed_at=now(),last_error='Reservation cancelled.',source_updated_at=r.updated_at
 WHERE account_id=p_account_id AND pms_reservation_id=r.id AND trigger_type IN ('before_checkin','checkin_day','after_checkout') AND status IN ('scheduled','failed');
 END IF;
 UPDATE public.pms_webhook_events SET status='processed',processing_started_at=NULL,processed_at=now(),retryable=false,next_attempt_at=NULL,error_message=NULL WHERE id=e.id;
 RETURN 'processed';
END;
$$;
REVOKE ALL ON FUNCTION public.crm_complete_canonical_event_v2(uuid,uuid,uuid,integer,bigint,jsonb,boolean,timestamptz,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_complete_canonical_event_v2(uuid,uuid,uuid,integer,bigint,jsonb,boolean,timestamptz,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.begin_pms_automation_execution(p_job_id uuid, p_attempt_count integer, p_contact_id uuid, p_expected_reservation_updated_at timestamp with time zone)
 RETURNS TABLE(automation_log_id uuid, disposition text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  claimed_job public.automation_trigger_jobs%ROWTYPE;
  job_automation public.automations%ROWTYPE;
  job_reservation public.pms_reservations%ROWTYPE;
  existing_log public.automation_logs%ROWTYPE;
  execution_log_id UUID;
BEGIN
  IF p_job_id IS NULL
     OR p_attempt_count IS NULL
     OR p_attempt_count < 1
     OR p_expected_reservation_updated_at IS NULL THEN
    RAISE EXCEPTION 'A claimed PMS automation job, attempt, and validated reservation version are required.';
  END IF;

  SELECT * INTO claimed_job
  FROM public.automation_trigger_jobs AS job
  WHERE job.id = p_job_id
  FOR UPDATE;

  IF NOT FOUND
     OR claimed_job.status <> 'processing'
     OR claimed_job.attempt_count <> p_attempt_count THEN
    RAISE EXCEPTION 'PMS automation job claim is no longer current.';
  END IF;

  SELECT * INTO job_automation
  FROM public.automations AS automation
  WHERE automation.id = claimed_job.automation_id
    AND automation.account_id = claimed_job.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PMS automation job automation relationship is invalid.';
  END IF;

  IF NOT job_automation.is_active
     OR job_automation.trigger_type <> claimed_job.trigger_type THEN
    RETURN QUERY SELECT NULL::UUID, 'ineligible'::TEXT;
    RETURN;
  END IF;

  IF p_contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.contacts AS contact
    WHERE contact.id = p_contact_id
      AND contact.account_id = claimed_job.account_id
  ) THEN
    RAISE EXCEPTION 'PMS automation job contact relationship is invalid.';
  END IF;

  -- Preserve replay behavior before evaluating the current reservation:
  -- completed/running identities must never be reopened or suppressed by a
  -- later reservation edit.
  SELECT * INTO existing_log
  FROM public.automation_logs AS log
  WHERE log.trigger_job_id = claimed_job.id
    AND log.trigger_job_execution_state = 'completed'
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT existing_log.id, 'already_completed'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO existing_log
  FROM public.automation_logs AS log
  WHERE log.trigger_job_id = claimed_job.id
    AND log.trigger_job_attempt_count = p_attempt_count;
  IF FOUND THEN
    RETURN QUERY SELECT existing_log.id, 'already_running'::TEXT;
    RETURN;
  END IF;

  IF public.automation_retry_block_reason(claimed_job.id, claimed_job.account_id) IS NOT NULL THEN
    RETURN QUERY SELECT NULL::UUID, 'unsafe_to_retry'::TEXT;
    RETURN;
  END IF;

  -- Lock only this job's canonical reservation until the RPC transaction
  -- commits. A concurrent PMS sync must therefore finish before this read or
  -- wait until after execution permission/identity has been acquired.
  SELECT * INTO job_reservation
  FROM public.pms_reservations AS reservation
  WHERE reservation.id = claimed_job.pms_reservation_id
    AND reservation.account_id = claimed_job.account_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PMS automation job reservation relationship is invalid.';
  END IF;

  IF job_reservation.canonical_reservation_id IS NOT NULL OR job_reservation.metadata->>'canonical_identity_pending'='true'
     OR (job_reservation.metadata->>'source_type'='pms_reservations'
         AND job_reservation.metadata->>'guest_resolution' IS DISTINCT FROM 'resolved')
     OR job_reservation.contact_id IS DISTINCT FROM p_contact_id
     OR NOT EXISTS(SELECT 1 FROM public.pms_integrations i WHERE i.id=job_reservation.pms_integration_id AND i.account_id=claimed_job.account_id AND i.status='connected')
     OR NOT EXISTS(SELECT 1 FROM public.pms_properties p WHERE p.id=job_reservation.pms_property_id AND p.account_id=claimed_job.account_id AND p.status='active')
  THEN
    RETURN QUERY SELECT NULL::UUID, 'ineligible'::TEXT;
    RETURN;
  END IF;

  IF claimed_job.pms_webhook_event_id IS NOT NULL AND job_reservation.metadata->>'source_type'='pms_reservations'
     AND NOT EXISTS(SELECT 1 FROM public.pms_webhook_events e WHERE e.id=claimed_job.pms_webhook_event_id
       AND e.account_id=claimed_job.account_id AND e.pms_integration_id=job_reservation.pms_integration_id
       AND e.pms_property_id=job_reservation.pms_property_id
       AND e.payload#>>'{data,source_version}'=job_reservation.canonical_source_version::text) THEN
    RETURN QUERY SELECT NULL::UUID, 'ineligible'::TEXT;
    RETURN;
  END IF;

  IF job_reservation.updated_at IS DISTINCT FROM p_expected_reservation_updated_at THEN
    RETURN QUERY SELECT NULL::UUID, 'reservation_changed'::TEXT;
    RETURN;
  END IF;

  INSERT INTO public.automation_logs (
    automation_id,
    account_id,
    user_id,
    contact_id,
    trigger_event,
    steps_executed,
    status,
    trigger_job_id,
    trigger_job_attempt_count,
    trigger_job_execution_state
  ) VALUES (
    claimed_job.automation_id,
    claimed_job.account_id,
    job_automation.user_id,
    p_contact_id,
    claimed_job.trigger_type,
    '[]'::jsonb,
    'failed',
    claimed_job.id,
    p_attempt_count,
    'processing'
  )
  RETURNING id INTO execution_log_id;

  RETURN QUERY SELECT execution_log_id, 'started'::TEXT;
END;
$function$;
CREATE OR REPLACE FUNCTION public.claim_automation_trigger_jobs(p_limit integer, p_stale_before timestamp with time zone, p_now timestamp with time zone)
 RETURNS TABLE(job_id uuid, account_id uuid, automation_id uuid, pms_reservation_id uuid, pms_webhook_event_id uuid, trigger_type text, run_at timestamp with time zone, processing_started_at timestamp with time zone, attempt_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'Automation trigger job claim limit must be between 1 and 50.';
  END IF;
  IF p_stale_before IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'Automation trigger job claim timestamps are required.';
  END IF;

  UPDATE public.automation_trigger_jobs AS expired
  SET
    status = 'failed',
    processing_started_at = NULL,
    retryable = FALSE,
    next_attempt_at = NULL,
    completed_at = p_now,
    last_error = 'Automation trigger job attempt limit reached.'
  WHERE expired.status = 'processing'
    AND expired.attempt_count >= 5
    AND (
      expired.processing_started_at IS NULL
      OR expired.processing_started_at <= p_stale_before
    );

  RETURN QUERY
  WITH candidates AS (
    SELECT candidate.id
    FROM public.automation_trigger_jobs AS candidate
    WHERE EXISTS (SELECT 1 FROM public.pms_reservations r WHERE r.id=candidate.pms_reservation_id
      AND r.account_id=candidate.account_id AND r.canonical_reservation_id IS NULL
      AND r.metadata->>'canonical_identity_pending' IS DISTINCT FROM 'true'
      AND (r.metadata->>'source_type' IS DISTINCT FROM 'pms_reservations' OR r.metadata->>'guest_resolution'='resolved'))
      AND candidate.run_at <= p_now
      AND (
        candidate.status = 'scheduled'
        OR (
          candidate.status = 'failed'
          AND candidate.retryable = TRUE
          AND candidate.attempt_count < 5
          AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= p_now)
        )
        OR (
          candidate.status = 'processing'
          AND candidate.attempt_count < 5
          AND (
            candidate.processing_started_at IS NULL
            OR candidate.processing_started_at <= p_stale_before
          )
        )
      )
    ORDER BY candidate.run_at ASC, candidate.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.automation_trigger_jobs AS job
  SET
    status = 'processing',
    processing_started_at = p_now,
    attempt_count = job.attempt_count + 1,
    retryable = FALSE,
    next_attempt_at = NULL,
    last_error = NULL,
    completed_at = NULL
  FROM candidates
  WHERE job.id = candidates.id
  RETURNING
    job.id,
    job.account_id,
    job.automation_id,
    job.pms_reservation_id,
    job.pms_webhook_event_id,
    job.trigger_type,
    job.run_at,
    job.processing_started_at,
    job.attempt_count;
END;
$function$;
CREATE OR REPLACE FUNCTION public.upsert_pms_automation_schedule_jobs(p_jobs jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  requested_count INTEGER;
  affected_count INTEGER := 0;
  completed_count INTEGER := 0;
  stale_count INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_jobs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_jobs must be a JSON array';
  END IF;

  requested_count := jsonb_array_length(p_jobs);
  IF requested_count = 0 THEN
    RETURN jsonb_build_object(
      'requested', 0,
      'affected', 0,
      'completed', 0,
      'stale', 0
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_jobs) AS job(
      account_id UUID,
      automation_id UUID,
      pms_reservation_id UUID,
      trigger_type TEXT,
      occurrence_key TEXT,
      run_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ
    )
    WHERE job.account_id IS NULL
       OR job.automation_id IS NULL
       OR job.pms_reservation_id IS NULL
       OR job.trigger_type NOT IN ('before_checkin', 'checkin_day', 'after_checkout')
       OR NULLIF(btrim(job.occurrence_key), '') IS NULL
       OR job.run_at IS NULL
       OR job.source_updated_at IS NULL
       OR job.occurrence_key <> format(
         'pms:schedule:%s:%s:%s',
         job.automation_id,
         job.pms_reservation_id,
         job.trigger_type
       )
  ) THEN
    RAISE EXCEPTION 'PMS schedule batch contains an invalid job.';
  END IF;

  IF EXISTS (
    SELECT job.occurrence_key
    FROM jsonb_to_recordset(p_jobs) AS job(occurrence_key TEXT)
    GROUP BY job.occurrence_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PMS schedule batch contains duplicate occurrence keys.';
  END IF;

  IF (
    SELECT count(DISTINCT (job.account_id, job.automation_id))
    FROM jsonb_to_recordset(p_jobs) AS job(
      account_id UUID,
      automation_id UUID
    )
  ) <> 1 THEN
    RAISE EXCEPTION 'PMS schedule batch must belong to one workspace automation.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_jobs) AS job(
      account_id UUID,
      automation_id UUID,
      pms_reservation_id UUID
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.automations AS automation
      WHERE automation.id = job.automation_id
        AND automation.account_id = job.account_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.pms_reservations AS reservation
      WHERE reservation.id = job.pms_reservation_id
        AND reservation.account_id = job.account_id
    )
  ) THEN
    RAISE EXCEPTION 'PMS schedule batch has an invalid workspace relationship.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_jobs) AS job(
      account_id UUID,
      automation_id UUID,
      pms_reservation_id UUID,
      trigger_type TEXT,
      occurrence_key TEXT
    )
    JOIN public.automation_trigger_jobs AS existing
      ON existing.occurrence_key = job.occurrence_key
    WHERE existing.account_id <> job.account_id
       OR existing.automation_id <> job.automation_id
       OR existing.pms_reservation_id <> job.pms_reservation_id
       OR existing.trigger_type <> job.trigger_type
       OR existing.pms_webhook_event_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PMS schedule occurrence key identity collision.';
  END IF;

  INSERT INTO public.automation_trigger_jobs (
    account_id,
    automation_id,
    pms_reservation_id,
    pms_webhook_event_id,
    trigger_type,
    occurrence_key,
    run_at,
    source_updated_at
  )
  SELECT
    job.account_id,
    job.automation_id,
    job.pms_reservation_id,
    NULL,
    job.trigger_type,
    job.occurrence_key,
    job.run_at,
    job.source_updated_at
  FROM jsonb_to_recordset(p_jobs) AS job(
    account_id UUID,
    automation_id UUID,
    pms_reservation_id UUID,
    trigger_type TEXT,
    occurrence_key TEXT,
    run_at TIMESTAMPTZ,
    source_updated_at TIMESTAMPTZ
  )
  JOIN public.pms_reservations AS reservation
    ON reservation.id = job.pms_reservation_id
   AND reservation.account_id = job.account_id
  -- A webhook may update or cancel a reservation after backfill selected it
  -- but before this statement. In that no-existing-row race, the canonical
  -- reservation version is the only safe concurrency boundary.
  WHERE reservation.updated_at <= job.source_updated_at
    AND NOT EXISTS (SELECT 1 FROM public.automation_trigger_jobs history
      JOIN public.pms_reservations alias ON alias.id=history.pms_reservation_id
      WHERE alias.canonical_reservation_id=reservation.id AND alias.account_id=job.account_id
      AND history.account_id=job.account_id AND history.automation_id=job.automation_id
      AND history.trigger_type=job.trigger_type AND history.status IN ('completed','processing'))
  ON CONFLICT (occurrence_key) DO UPDATE
  SET
    run_at = EXCLUDED.run_at,
    source_updated_at = EXCLUDED.source_updated_at,
    status = 'scheduled',
    processing_started_at = NULL,
    retryable = FALSE,
    next_attempt_at = NULL,
    last_error = NULL,
    completed_at = NULL
  WHERE public.automation_trigger_jobs.status NOT IN ('completed','processing')
    AND public.automation_trigger_jobs.account_id = EXCLUDED.account_id
    AND public.automation_trigger_jobs.automation_id = EXCLUDED.automation_id
    AND public.automation_trigger_jobs.pms_reservation_id = EXCLUDED.pms_reservation_id
    AND public.automation_trigger_jobs.trigger_type = EXCLUDED.trigger_type
    AND public.automation_trigger_jobs.pms_webhook_event_id IS NULL
    AND (
      public.automation_trigger_jobs.source_updated_at IS NULL
      OR EXCLUDED.source_updated_at >= public.automation_trigger_jobs.source_updated_at
    );

  GET DIAGNOSTICS affected_count = ROW_COUNT;

  SELECT count(*) INTO completed_count
  FROM jsonb_to_recordset(p_jobs) AS job(account_id uuid,automation_id uuid,pms_reservation_id uuid,trigger_type text)
  WHERE EXISTS(SELECT 1 FROM public.automation_trigger_jobs history
    JOIN public.pms_reservations alias ON alias.id=history.pms_reservation_id
    WHERE history.account_id=job.account_id AND alias.account_id=job.account_id
    AND (alias.id=job.pms_reservation_id OR alias.canonical_reservation_id=job.pms_reservation_id)
    AND history.automation_id=job.automation_id AND history.trigger_type=job.trigger_type
    AND history.pms_webhook_event_id IS NULL AND history.status IN ('completed','processing'));

  SELECT count(*) INTO stale_count
  FROM jsonb_to_recordset(p_jobs) AS job(
    account_id UUID,
    automation_id UUID,
    pms_reservation_id UUID,
    trigger_type TEXT,
    occurrence_key TEXT,
    source_updated_at TIMESTAMPTZ
  )
  JOIN public.pms_reservations AS reservation
    ON reservation.id = job.pms_reservation_id
   AND reservation.account_id = job.account_id
  LEFT JOIN public.automation_trigger_jobs AS existing
    ON existing.occurrence_key = job.occurrence_key
   AND existing.account_id = job.account_id
   AND existing.automation_id = job.automation_id
   AND existing.pms_reservation_id = job.pms_reservation_id
   AND existing.trigger_type = job.trigger_type
   AND existing.pms_webhook_event_id IS NULL
  WHERE coalesce(existing.status,'') NOT IN ('completed','processing')
    AND NOT EXISTS(SELECT 1 FROM public.automation_trigger_jobs history
      JOIN public.pms_reservations alias ON alias.id=history.pms_reservation_id
      WHERE alias.canonical_reservation_id=job.pms_reservation_id AND alias.account_id=job.account_id
      AND history.account_id=job.account_id AND history.automation_id=job.automation_id
      AND history.trigger_type=job.trigger_type AND history.status IN ('completed','processing'))
    AND (
      reservation.updated_at > job.source_updated_at
      OR existing.source_updated_at > job.source_updated_at
    );

  IF affected_count + completed_count + stale_count <> requested_count THEN
    RAISE EXCEPTION 'PMS schedule batch did not converge completely.';
  END IF;

  RETURN jsonb_build_object(
    'requested', requested_count,
    'affected', affected_count,
    'completed', completed_count,
    'stale', stale_count
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.begin_pms_automation_execution(uuid,integer,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_pms_automation_execution(uuid,integer,uuid,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.claim_automation_trigger_jobs(integer,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automation_trigger_jobs(integer,timestamptz,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.upsert_pms_automation_schedule_jobs(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pms_automation_schedule_jobs(jsonb) TO service_role;

-- Earlier clients stored end-of-run timestamps, which can hide rows. Force one
-- silent full reconciliation and preserve the previous watermark for rollback.
UPDATE public.pms_properties p SET metadata=p.metadata||jsonb_build_object('canonical_v2_previous_watermark',p.last_reconciled_at),
 last_reconciled_at=NULL WHERE EXISTS(SELECT 1 FROM public.pms_integrations i WHERE i.id=p.pms_integration_id AND i.provider='rukiye_zara');
COMMIT;
