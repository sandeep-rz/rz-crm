-- Rolling-deployment-safe overload of the PMS execution gate. The existing
-- three-argument function remains available to already-running application
-- instances; new instances use this reservation-version-aware signature.
CREATE FUNCTION public.begin_pms_automation_execution(
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
  FOR UPDATE;

  IF FOUND THEN
    IF existing_log.trigger_job_execution_state = 'completed' THEN
      RETURN QUERY SELECT existing_log.id, 'already_completed'::TEXT;
      RETURN;
    END IF;

    IF existing_log.trigger_job_execution_state = 'processing'
       AND existing_log.trigger_job_attempt_count = p_attempt_count THEN
      RETURN QUERY SELECT existing_log.id, 'already_running'::TEXT;
      RETURN;
    END IF;
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

  IF existing_log.id IS NOT NULL THEN
    UPDATE public.automation_logs AS log
    SET
      automation_id = claimed_job.automation_id,
      account_id = claimed_job.account_id,
      user_id = job_automation.user_id,
      contact_id = p_contact_id,
      trigger_event = claimed_job.trigger_type,
      steps_executed = '[]'::jsonb,
      status = 'failed',
      error_message = NULL,
      trigger_job_attempt_count = p_attempt_count,
      trigger_job_execution_state = 'processing'
    WHERE log.id = existing_log.id;

    RETURN QUERY SELECT existing_log.id, 'started'::TEXT;
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
