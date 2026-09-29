-- Durable PMS occurrences and reservation-relative schedules feeding the
-- existing automation engine. This table is a queue/ledger, not a second
-- workflow definition or action engine.

BEGIN;

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

ALTER TABLE public.automations
  ADD CONSTRAINT automations_id_account_key UNIQUE (id, account_id);

ALTER TABLE public.pms_reservations
  ADD CONSTRAINT pms_reservations_id_account_key UNIQUE (id, account_id);

ALTER TABLE public.pms_webhook_events
  ADD CONSTRAINT pms_webhook_events_id_account_key UNIQUE (id, account_id);

CREATE TABLE public.automation_trigger_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL,
  pms_reservation_id UUID NOT NULL,
  pms_webhook_event_id UUID,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'reservation_confirmed',
    'reservation_updated',
    'reservation_cancelled',
    'before_checkin',
    'checkin_day',
    'after_checkout'
  )),
  occurrence_key TEXT NOT NULL CHECK (length(btrim(occurrence_key)) > 0),
  run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled', 'processing', 'completed', 'cancelled', 'suppressed', 'failed'
  )),
  processing_started_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  completed_at TIMESTAMPTZ,
  CONSTRAINT automation_trigger_jobs_automation_account_fkey
    FOREIGN KEY (automation_id, account_id)
    REFERENCES public.automations(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_trigger_jobs_reservation_account_fkey
    FOREIGN KEY (pms_reservation_id, account_id)
    REFERENCES public.pms_reservations(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_trigger_jobs_event_account_fkey
    FOREIGN KEY (pms_webhook_event_id, account_id)
    REFERENCES public.pms_webhook_events(id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_trigger_jobs_source_shape_check CHECK (
    (trigger_type IN ('reservation_confirmed', 'reservation_updated', 'reservation_cancelled')
      AND pms_webhook_event_id IS NOT NULL)
    OR
    (trigger_type IN ('before_checkin', 'checkin_day', 'after_checkout')
      AND pms_webhook_event_id IS NULL)
  ),
  CONSTRAINT automation_trigger_jobs_id_account_key UNIQUE (id, account_id),
  CONSTRAINT automation_trigger_jobs_occurrence_key_unique UNIQUE (occurrence_key)
);

-- Each PMS job owns exactly one durable automation execution identity. The
-- nullable provenance keeps all existing non-PMS automation logs unchanged.
ALTER TABLE public.automation_logs
  ADD COLUMN trigger_job_id UUID,
  ADD COLUMN trigger_job_attempt_count INTEGER
    CHECK (trigger_job_attempt_count IS NULL OR trigger_job_attempt_count > 0),
  ADD COLUMN trigger_job_execution_state TEXT
    CHECK (trigger_job_execution_state IS NULL OR trigger_job_execution_state IN (
      'processing', 'completed', 'failed'
    )),
  ADD CONSTRAINT automation_logs_trigger_job_unique UNIQUE (trigger_job_id),
  ADD CONSTRAINT automation_logs_trigger_job_account_fkey
    FOREIGN KEY (trigger_job_id, account_id)
    REFERENCES public.automation_trigger_jobs(id, account_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT automation_logs_trigger_job_shape_check CHECK (
    (trigger_job_id IS NULL
      AND trigger_job_attempt_count IS NULL
      AND trigger_job_execution_state IS NULL)
    OR
    (trigger_job_id IS NOT NULL
      AND trigger_job_attempt_count IS NOT NULL
      AND trigger_job_execution_state IS NOT NULL)
  );

CREATE INDEX automation_logs_trigger_job_completed_idx
  ON public.automation_logs(trigger_job_id, trigger_job_execution_state)
  WHERE trigger_job_id IS NOT NULL;

COMMENT ON COLUMN public.automation_logs.trigger_job_id IS
  'Unique durable PMS automation job identity; null for all non-PMS executions.';
COMMENT ON COLUMN public.automation_logs.trigger_job_attempt_count IS
  'Job claim attempt that atomically acquired this execution identity.';
COMMENT ON COLUMN public.automation_logs.trigger_job_execution_state IS
  'PMS dispatch gate state. Completed means the existing step tree reached success or a durable wait suspension.';

-- Defense in depth: even a malformed application occurrence key cannot create
-- two jobs for the same event occurrence or current logical schedule.
CREATE UNIQUE INDEX automation_trigger_jobs_event_occurrence_unique
  ON public.automation_trigger_jobs(
    automation_id, pms_reservation_id, pms_webhook_event_id, trigger_type
  )
  WHERE pms_webhook_event_id IS NOT NULL;

CREATE UNIQUE INDEX automation_trigger_jobs_scheduled_occurrence_unique
  ON public.automation_trigger_jobs(automation_id, pms_reservation_id, trigger_type)
  WHERE pms_webhook_event_id IS NULL;

CREATE INDEX automation_trigger_jobs_due_claim_idx
  ON public.automation_trigger_jobs(status, next_attempt_at, run_at, created_at)
  WHERE status IN ('scheduled', 'processing', 'failed');

CREATE INDEX automation_trigger_jobs_reservation_idx
  ON public.automation_trigger_jobs(account_id, pms_reservation_id, status);

CREATE INDEX automation_trigger_jobs_automation_idx
  ON public.automation_trigger_jobs(account_id, automation_id, created_at DESC);

CREATE TRIGGER set_automation_trigger_jobs_updated_at
BEFORE UPDATE ON public.automation_trigger_jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.automation_trigger_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_trigger_jobs_select_member
ON public.automation_trigger_jobs
FOR SELECT
TO authenticated
USING (public.is_account_member(account_id));

REVOKE ALL ON TABLE public.automation_trigger_jobs FROM anon, authenticated;
GRANT SELECT ON TABLE public.automation_trigger_jobs TO authenticated;
GRANT ALL ON TABLE public.automation_trigger_jobs TO service_role;

COMMENT ON TABLE public.automation_trigger_jobs IS
  'Durable PMS event occurrences and reservation-relative schedules dispatched into the existing automation engine.';

-- Atomically acquire the one automation execution owned by a claimed PMS job.
-- Locking the job row serializes duplicate invocations. A retry may reuse a
-- failed/stale execution, but a successful execution can never be restarted.
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
  'Atomically creates or recovers the unique automation log owned by a current PMS job claim and refuses duplicate execution of a completed or concurrently running attempt.';

CREATE OR REPLACE FUNCTION public.claim_automation_trigger_jobs(
  p_limit INTEGER,
  p_stale_before TIMESTAMPTZ,
  p_now TIMESTAMPTZ
)
RETURNS TABLE (
  job_id UUID,
  account_id UUID,
  automation_id UUID,
  pms_reservation_id UUID,
  pms_webhook_event_id UUID,
  trigger_type TEXT,
  run_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
    WHERE candidate.run_at <= p_now
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
$$;

REVOKE ALL
ON FUNCTION public.claim_automation_trigger_jobs(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
ON FUNCTION public.claim_automation_trigger_jobs(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ)
TO service_role;

CREATE OR REPLACE FUNCTION public.wake_pms_automation_worker()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  worker_url TEXT;
  worker_token TEXT;
  request_id BIGINT;
BEGIN
  SELECT decrypted_secret INTO worker_url
  FROM vault.decrypted_secrets
  WHERE name = 'pms_automation_worker_url'
  LIMIT 1;

  SELECT decrypted_secret INTO worker_token
  FROM vault.decrypted_secrets
  WHERE name = 'pms_sync_worker_token'
  LIMIT 1;

  IF NULLIF(btrim(worker_url), '') IS NULL
     OR NULLIF(btrim(worker_token), '') IS NULL
     OR worker_url !~* '^https://' THEN
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := worker_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-pms-sync-worker-token', worker_token
    ),
    body := jsonb_build_object('source', 'supabase'),
    timeout_milliseconds := 5000
  ) INTO request_id;

  RETURN request_id;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.wake_pms_automation_worker()
FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  SELECT jobid INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'pms-automation-trigger-worker'
  LIMIT 1;

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;

  PERFORM cron.schedule(
    'pms-automation-trigger-worker',
    '* * * * *',
    $cron$SELECT public.wake_pms_automation_worker();$cron$
  );
END;
$$;

COMMIT;
