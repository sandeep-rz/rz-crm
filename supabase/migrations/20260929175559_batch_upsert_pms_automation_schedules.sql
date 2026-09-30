-- Batch lifecycle scheduling for existing PMS reservations. This writes to
-- the existing queue and relies on its occurrence/FK constraints; it is not a
-- second scheduler or executor.

CREATE OR REPLACE FUNCTION public.upsert_pms_automation_schedule_jobs(
  p_jobs JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected_count INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_jobs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_jobs must be a JSON array';
  END IF;

  INSERT INTO public.automation_trigger_jobs (
    account_id,
    automation_id,
    pms_reservation_id,
    pms_webhook_event_id,
    trigger_type,
    occurrence_key,
    run_at
  )
  SELECT
    job.account_id,
    job.automation_id,
    job.pms_reservation_id,
    NULL,
    job.trigger_type,
    job.occurrence_key,
    job.run_at
  FROM jsonb_to_recordset(p_jobs) AS job(
    account_id UUID,
    automation_id UUID,
    pms_reservation_id UUID,
    trigger_type TEXT,
    occurrence_key TEXT,
    run_at TIMESTAMPTZ
  )
  ON CONFLICT (occurrence_key) DO UPDATE
  SET
    run_at = EXCLUDED.run_at,
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
    AND public.automation_trigger_jobs.pms_webhook_event_id IS NULL;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

REVOKE ALL
ON FUNCTION public.upsert_pms_automation_schedule_jobs(JSONB)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.upsert_pms_automation_schedule_jobs(JSONB)
TO service_role;

COMMENT ON FUNCTION public.upsert_pms_automation_schedule_jobs(JSONB) IS
  'Atomically inserts or reschedules batches of future PMS timing occurrences without reopening completed executions.';
