-- Containment only: a durable restart guard on the existing execution log.
BEGIN;
ALTER TABLE public.automation_logs ADD COLUMN retry_safety JSONB;
COMMENT ON COLUMN public.automation_logs.retry_safety IS
  'Non-null means whole-execution replay is unsafe. Records action/acceptance evidence, never a resume cursor.';

CREATE FUNCTION public.automation_retry_block_reason(p_job_id UUID, p_account_id UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN l.retry_safety IS NOT NULL THEN COALESCE(l.retry_safety->>'reason', 'external_action')
    ELSE 'external_action' END
  FROM public.automation_logs l
  WHERE l.trigger_job_id = p_job_id AND l.account_id = p_account_id
    AND (l.retry_safety IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(l.steps_executed) step
        WHERE step->>'status' = 'success' AND step->>'step_type' IN
          ('send_template','send_message','send_buttons','send_list','send_webhook','create_deal')))
  ORDER BY CASE WHEN COALESCE(l.retry_safety->>'reason', '') LIKE 'whatsapp_%' THEN 0 ELSE 1 END, l.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.automation_retry_block_reason(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_retry_block_reason(UUID, UUID) TO service_role;

CREATE FUNCTION public.record_automation_retry_safety(
  p_log_id UUID, p_account_id UUID, p_step_id UUID, p_safety JSONB,
  p_pending_execution_id UUID DEFAULT NULL, p_pending_attempt_count INTEGER DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE execution public.automation_logs%ROWTYPE; job public.automation_trigger_jobs%ROWTYPE;
  pending public.automation_pending_executions%ROWTYPE; segment_safety JSONB;
BEGIN
  SELECT * INTO execution FROM public.automation_logs WHERE id = p_log_id AND account_id = p_account_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  -- Match the acquisition/retry lock order and fence expired attempts before a side effect.
  IF execution.trigger_job_id IS NOT NULL THEN
    SELECT * INTO job FROM public.automation_trigger_jobs WHERE id = execution.trigger_job_id
      AND account_id = p_account_id FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    -- A root must still own its live PMS claim. Waits use their own pending claim below.
    IF p_pending_execution_id IS NULL AND
      (job.attempt_count IS DISTINCT FROM execution.trigger_job_attempt_count
        OR job.status <> 'processing') THEN RETURN FALSE; END IF;
  END IF;
  -- Same ordering everywhere: trigger job, pending continuation, then log.
  -- Reuse the existing continuation context for a segment-local latch, not a cursor.
  IF p_pending_execution_id IS NOT NULL THEN
    SELECT * INTO pending FROM public.automation_pending_executions
      WHERE id = p_pending_execution_id AND account_id = p_account_id
        AND log_id = p_log_id AND automation_id = execution.automation_id FOR UPDATE;
    IF NOT FOUND OR pending.status <> 'running'
      OR pending.attempt_count IS DISTINCT FROM p_pending_attempt_count THEN RETURN FALSE; END IF;
    segment_safety := pending.context->'__retry_safety';
  ELSIF p_pending_attempt_count IS NOT NULL THEN RETURN FALSE;
  END IF;
  IF p_safety IS NULL THEN
    UPDATE public.automation_logs SET retry_safety = NULL
      WHERE id = p_log_id AND account_id = p_account_id
        AND retry_safety->>'step_id' = p_step_id::TEXT
        AND retry_safety->>'reason' = 'whatsapp_unknown';
  ELSE
    IF p_safety->>'reason' IS NULL OR p_safety->>'reason' NOT IN ('external_action','whatsapp_unknown','whatsapp_accepted')
      OR p_safety->>'step_id' IS DISTINCT FROM p_step_id::TEXT THEN RETURN FALSE; END IF;
    UPDATE public.automation_logs SET retry_safety = p_safety
      WHERE id = p_log_id AND account_id = p_account_id
        AND (retry_safety IS NULL OR
          (retry_safety->>'reason' = 'whatsapp_unknown'
            AND retry_safety->>'step_id' = p_step_id::TEXT
            AND p_safety->>'reason' = 'whatsapp_accepted'));
  END IF;
  IF p_pending_execution_id IS NOT NULL THEN
    IF p_safety IS NULL THEN
      IF segment_safety->>'reason' = 'whatsapp_unknown'
        AND segment_safety->>'step_id' = p_step_id::TEXT THEN
        UPDATE public.automation_pending_executions SET context = context - '__retry_safety'
          WHERE id = p_pending_execution_id AND account_id = p_account_id;
      END IF;
    ELSIF segment_safety IS NULL OR
      (segment_safety->>'reason' = 'whatsapp_unknown'
        AND segment_safety->>'step_id' = p_step_id::TEXT
        AND p_safety->>'reason' = 'whatsapp_accepted') THEN
      UPDATE public.automation_pending_executions
        SET context = jsonb_set(context, '{__retry_safety}', p_safety)
        WHERE id = p_pending_execution_id AND account_id = p_account_id;
    END IF;
  END IF;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.record_automation_retry_safety(UUID, UUID, UUID, JSONB, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_automation_retry_safety(UUID, UUID, UUID, JSONB, UUID, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.begin_pms_automation_execution(
  p_job_id UUID,
  p_attempt_count INTEGER,
  p_contact_id UUID,
  p_expected_reservation_updated_at TIMESTAMPTZ
)
RETURNS TABLE (
  automation_log_id UUID,
  disposition TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

REVOKE ALL
ON FUNCTION public.begin_pms_automation_execution(UUID, INTEGER, UUID, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.begin_pms_automation_execution(UUID, INTEGER, UUID, TIMESTAMPTZ)
TO service_role;

COMMENT ON FUNCTION public.begin_pms_automation_execution(UUID, INTEGER, UUID, TIMESTAMPTZ) IS
  'Acquires the unique PMS execution identity only when the claimed job, automation, and worker-validated canonical reservation version are still current.';

CREATE OR REPLACE FUNCTION public.get_pms_automation_retry_states(p_account_id UUID, p_log_ids UUID[])
RETURNS TABLE(log_id UUID, retry_state TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id, CASE
    WHEN j.status = 'completed' OR EXISTS (
      SELECT 1 FROM public.automation_logs x WHERE x.trigger_job_id = j.id
        AND x.trigger_job_execution_state = 'completed'
    ) THEN 'already_completed'
    WHEN public.automation_retry_block_reason(j.id, p_account_id) IS NOT NULL THEN 'unsafe_to_retry'
    WHEN j.status IN ('scheduled', 'processing') THEN 'already_retried'
    WHEN j.status = 'failed' AND l.trigger_job_attempt_count = j.attempt_count
      AND l.status = 'failed' AND l.trigger_job_execution_state = 'failed'
      AND NOT EXISTS (SELECT 1 FROM public.automation_logs x
        WHERE x.trigger_job_id = j.id AND x.trigger_job_execution_state = 'processing')
      THEN 'eligible'
    ELSE 'not_eligible' END
  FROM public.automation_logs l
  JOIN public.automation_trigger_jobs j ON j.id = l.trigger_job_id
    AND j.account_id = l.account_id AND j.automation_id = l.automation_id
  WHERE l.account_id = p_account_id AND l.id = ANY(p_log_ids)
  LIMIT 100;
$$;
REVOKE ALL ON FUNCTION public.get_pms_automation_retry_states(UUID, UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pms_automation_retry_states(UUID, UUID[]) TO service_role;

CREATE OR REPLACE FUNCTION public.retry_pms_automation_execution(p_log_id UUID, p_account_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE job public.automation_trigger_jobs%ROWTYPE; execution public.automation_logs%ROWTYPE;
BEGIN
  SELECT * INTO execution FROM public.automation_logs l
    WHERE l.id = p_log_id AND l.account_id = p_account_id AND l.trigger_job_id IS NOT NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO job FROM public.automation_trigger_jobs j
    WHERE j.id = execution.trigger_job_id AND j.account_id = p_account_id
      AND j.automation_id = execution.automation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF job.status = 'completed' OR EXISTS (
    SELECT 1 FROM public.automation_logs l WHERE l.trigger_job_id = job.id
      AND l.trigger_job_execution_state = 'completed'
  ) THEN RETURN 'already_completed'; END IF;
  IF public.automation_retry_block_reason(job.id, p_account_id) IS NOT NULL THEN RETURN 'unsafe_to_retry'; END IF;
  IF job.status IN ('scheduled', 'processing') THEN RETURN 'already_retried'; END IF;
  IF job.status <> 'failed' THEN RETURN 'not_failed'; END IF;
  IF execution.trigger_job_attempt_count IS DISTINCT FROM job.attempt_count
    OR execution.status IS DISTINCT FROM 'failed'
    OR execution.trigger_job_execution_state IS DISTINCT FROM 'failed'
    OR EXISTS (SELECT 1 FROM public.automation_logs l WHERE l.trigger_job_id = job.id
      AND l.trigger_job_execution_state = 'processing')
    THEN RETURN 'unsafe_to_retry'; END IF;
  -- Keep attempts, retryable and last_error. The normal claim starts the next attempt.
  UPDATE public.automation_trigger_jobs SET status = 'scheduled', run_at = now(),
    next_attempt_at = NULL, processing_started_at = NULL, completed_at = NULL
    WHERE id = job.id
      AND account_id = p_account_id
      AND status = 'failed';
  IF NOT FOUND THEN
    RETURN 'already_retried';
  END IF;
  PERFORM public.wake_pms_automation_worker();
  RETURN 'queued';
END;
$$;
REVOKE ALL ON FUNCTION public.retry_pms_automation_execution(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_pms_automation_execution(UUID, UUID) TO service_role;
COMMIT;
