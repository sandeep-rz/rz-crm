-- Preserve failed attempts while retaining one queue/engine and the completed-occurrence gate.
BEGIN;
ALTER TABLE public.automation_logs DROP CONSTRAINT automation_logs_trigger_job_unique;
ALTER TABLE public.automation_logs ADD CONSTRAINT automation_logs_trigger_job_attempt_unique
  UNIQUE (trigger_job_id, trigger_job_attempt_count);
CREATE UNIQUE INDEX automation_logs_one_completed_occurrence
  ON public.automation_logs(trigger_job_id)
  WHERE trigger_job_execution_state = 'completed';
COMMENT ON COLUMN public.automation_logs.trigger_job_id IS
  'PMS occurrence identity; one immutable historical log per claim attempt, null for non-PMS runs.';

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

CREATE OR REPLACE FUNCTION public.begin_pms_automation_execution(
  p_job_id UUID, p_attempt_count INTEGER, p_contact_id UUID
) RETURNS TABLE (automation_log_id UUID, disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE reservation_version TIMESTAMPTZ;
BEGIN
  SELECT reservation.updated_at INTO reservation_version
  FROM public.automation_trigger_jobs AS job
  JOIN public.pms_reservations AS reservation ON reservation.id = job.pms_reservation_id
    AND reservation.account_id = job.account_id
  WHERE job.id = p_job_id;
  -- Older three-argument clients understand ineligible, but not reservation_changed.
  RETURN QUERY SELECT gate.automation_log_id,
    CASE WHEN gate.disposition = 'reservation_changed' THEN 'ineligible' ELSE gate.disposition END
  FROM public.begin_pms_automation_execution(
    p_job_id, p_attempt_count, p_contact_id, reservation_version) AS gate;
END;
$$;
REVOKE ALL ON FUNCTION public.begin_pms_automation_execution(UUID, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_pms_automation_execution(UUID, INTEGER, UUID) TO service_role;

-- Advisory bulk state for the Activity page. Execution validation stays in the worker.
CREATE FUNCTION public.get_pms_automation_retry_states(p_account_id UUID, p_log_ids UUID[])
RETURNS TABLE(log_id UUID, retry_state TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id, CASE
    WHEN j.status = 'completed' OR EXISTS (
      SELECT 1 FROM public.automation_logs x WHERE x.trigger_job_id = j.id
        AND x.trigger_job_execution_state = 'completed'
    ) THEN 'already_completed'
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

CREATE FUNCTION public.retry_pms_automation_execution(p_log_id UUID, p_account_id UUID)
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
