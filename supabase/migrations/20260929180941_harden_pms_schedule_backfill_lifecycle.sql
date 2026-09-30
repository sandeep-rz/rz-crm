ALTER TABLE public.automation_trigger_jobs
  ADD COLUMN source_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.automation_trigger_jobs.source_updated_at IS
  'Canonical PMS reservation version used to prevent stale backfill data from overwriting a newer webhook schedule.';

DROP FUNCTION public.upsert_pms_automation_schedule_jobs(JSONB);

CREATE FUNCTION public.upsert_pms_automation_schedule_jobs(
  p_jobs JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
  WHERE public.automation_trigger_jobs.status <> 'completed'
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
  FROM jsonb_to_recordset(p_jobs) AS job(
    account_id UUID,
    automation_id UUID,
    pms_reservation_id UUID,
    trigger_type TEXT,
    occurrence_key TEXT
  )
  JOIN public.automation_trigger_jobs AS existing
    ON existing.occurrence_key = job.occurrence_key
   AND existing.account_id = job.account_id
   AND existing.automation_id = job.automation_id
   AND existing.pms_reservation_id = job.pms_reservation_id
   AND existing.trigger_type = job.trigger_type
   AND existing.pms_webhook_event_id IS NULL
  WHERE existing.status = 'completed';

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
  WHERE existing.status IS DISTINCT FROM 'completed'
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
$$;

REVOKE ALL
ON FUNCTION public.upsert_pms_automation_schedule_jobs(JSONB)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.upsert_pms_automation_schedule_jobs(JSONB)
TO service_role;

COMMENT ON FUNCTION public.upsert_pms_automation_schedule_jobs(JSONB) IS
  'Validates and atomically reconciles PMS timing jobs, preserving completed executions and newer reservation versions.';

CREATE OR REPLACE FUNCTION public.begin_pms_automation_execution(
  p_job_id UUID,
  p_attempt_count INTEGER,
  p_contact_id UUID
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
  existing_log public.automation_logs%ROWTYPE;
  execution_log_id UUID;
BEGIN
  IF p_job_id IS NULL OR p_attempt_count IS NULL OR p_attempt_count < 1 THEN
    RAISE EXCEPTION 'A claimed PMS automation job and attempt are required.';
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
ON FUNCTION public.begin_pms_automation_execution(UUID, INTEGER, UUID)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.begin_pms_automation_execution(UUID, INTEGER, UUID)
TO service_role;

COMMENT ON FUNCTION public.begin_pms_automation_execution(UUID, INTEGER, UUID) IS
  'Acquires the unique PMS execution identity only while the claimed job automation is still active and still matches its trigger.';
