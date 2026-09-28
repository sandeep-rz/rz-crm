-- Durable, application-owned processing for authenticated PMS webhook receipts.
--
-- PostgreSQL owns only durable state transitions, atomic claims, and worker
-- wake-ups. Canonical PMS reads and CRM projection remain application work.
--
-- Configure this additional Vault secret after applying the migration:
--   pms_webhook_worker_url =
--     https://crm.example.com/api/integrations/pms/webhooks/worker
--
-- The existing pms_sync_worker_token Vault secret is reused and must match the
-- CRM deployment's PMS_SYNC_WORKER_TOKEN environment variable.

BEGIN;

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Add only the processing metadata not already present in migration 052.
ALTER TABLE public.pms_webhook_events
  DROP CONSTRAINT pms_webhook_events_status_check;

ALTER TABLE public.pms_webhook_events
  ADD CONSTRAINT pms_webhook_events_status_check
  CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed')),
  ADD COLUMN processing_started_at TIMESTAMPTZ,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  ADD COLUMN retryable BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN next_attempt_at TIMESTAMPTZ;

-- Enforce the complete property/integration/account boundary. The original
-- property/account FK did not prevent a same-account property from a different
-- integration being paired with an event.
ALTER TABLE public.pms_webhook_events
  DROP CONSTRAINT pms_webhook_events_property_account_fkey,
  ADD CONSTRAINT pms_webhook_events_property_integration_account_fkey
    FOREIGN KEY (pms_property_id, pms_integration_id, account_id)
    REFERENCES public.pms_properties(id, pms_integration_id, account_id)
    ON DELETE CASCADE;

CREATE INDEX idx_pms_webhook_events_worker_claim
  ON public.pms_webhook_events(status, next_attempt_at, created_at)
  WHERE status IN ('received', 'processing', 'failed');

COMMENT ON COLUMN public.pms_webhook_events.processing_started_at IS
  'Lease start for the current application worker claim; stale leases may be reclaimed.';
COMMENT ON COLUMN public.pms_webhook_events.attempt_count IS
  'Number of successful atomic processing claims, including stale-lease recovery claims.';
COMMENT ON COLUMN public.pms_webhook_events.retryable IS
  'Whether a failed event may be reclaimed after next_attempt_at and before the bounded attempt limit.';
COMMENT ON COLUMN public.pms_webhook_events.next_attempt_at IS
  'Earliest time a retryable failed event may be atomically reclaimed.';

-- Atomically lease a bounded batch without holding a transaction open during
-- provider HTTP calls. SKIP LOCKED allows overlapping worker wake-ups while
-- ensuring only one worker receives each claim attempt.
CREATE OR REPLACE FUNCTION public.claim_pms_webhook_events(
  p_limit INTEGER,
  p_stale_before TIMESTAMPTZ,
  p_now TIMESTAMPTZ
)
RETURNS TABLE (
  event_id UUID,
  provider TEXT,
  external_event_id TEXT,
  account_id UUID,
  pms_integration_id UUID,
  pms_property_id UUID,
  event_type TEXT,
  external_resource_id TEXT,
  occurred_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'PMS webhook claim limit must be between 1 and 50.';
  END IF;
  IF p_stale_before IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'PMS webhook claim timestamps are required.';
  END IF;

  -- A worker can disappear during its final allowed attempt. Convert that
  -- expired lease into a durable terminal failure instead of leaving it in
  -- processing forever.
  UPDATE public.pms_webhook_events AS expired
  SET
    status = 'failed',
    processing_started_at = NULL,
    retryable = FALSE,
    next_attempt_at = NULL,
    error_message = 'PMS webhook processing attempt limit reached.'
  WHERE expired.status = 'processing'
    AND expired.attempt_count >= 5
    AND (
      expired.processing_started_at IS NULL
      OR expired.processing_started_at <= p_stale_before
    );

  RETURN QUERY
  WITH candidates AS (
    SELECT candidate.id
    FROM public.pms_webhook_events AS candidate
    WHERE
      candidate.status = 'received'
      OR (
        candidate.status = 'failed'
        AND candidate.retryable = TRUE
        AND candidate.attempt_count < 5
        AND (
          candidate.next_attempt_at IS NULL
          OR candidate.next_attempt_at <= p_now
        )
      )
      OR (
        candidate.status = 'processing'
        AND (
          candidate.processing_started_at IS NULL
          OR candidate.processing_started_at <= p_stale_before
        )
        AND candidate.attempt_count < 5
      )
    ORDER BY candidate.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.pms_webhook_events AS event
  SET
    status = 'processing',
    processing_started_at = p_now,
    attempt_count = event.attempt_count + 1,
    retryable = FALSE,
    next_attempt_at = NULL
  FROM candidates
  WHERE event.id = candidates.id
  RETURNING
    event.id,
    event.provider,
    event.external_event_id,
    event.account_id,
    event.pms_integration_id,
    event.pms_property_id,
    event.event_type,
    event.external_resource_id,
    event.occurred_at,
    event.processing_started_at,
    event.attempt_count;
END;
$$;

REVOKE ALL
ON FUNCTION public.claim_pms_webhook_events(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.claim_pms_webhook_events(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ)
TO service_role;

COMMENT ON FUNCTION public.claim_pms_webhook_events(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Atomically leases received, due retryable, or stale-processing PMS webhook events for the service-role worker.';

CREATE OR REPLACE FUNCTION public.wake_pms_webhook_event_worker()
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
  SELECT decrypted_secret
  INTO worker_url
  FROM vault.decrypted_secrets
  WHERE name = 'pms_webhook_worker_url'
  LIMIT 1;

  SELECT decrypted_secret
  INTO worker_token
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
  )
  INTO request_id;

  RETURN request_id;
EXCEPTION
  WHEN OTHERS THEN
    -- Delivery is best effort. Receipt insertion must always remain durable.
    RETURN NULL;
END;
$$;

REVOKE ALL
ON FUNCTION public.wake_pms_webhook_event_worker()
FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.wake_pms_webhook_event_worker() IS
  'Queues a best-effort authenticated pg_net wake-up for the application PMS webhook-event worker.';

CREATE OR REPLACE FUNCTION public.wake_pms_webhook_event_worker_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.wake_pms_webhook_event_worker();
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- An immediate wake-up failure must never fail authenticated receipt.
    RETURN NEW;
END;
$$;

REVOKE ALL
ON FUNCTION public.wake_pms_webhook_event_worker_on_insert()
FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.wake_pms_webhook_event_worker_on_insert() IS
  'Best-effort immediate worker wake-up after a supported reservation event is durably inserted.';

DROP TRIGGER IF EXISTS pms_webhook_event_worker_wakeup
ON public.pms_webhook_events;

CREATE TRIGGER pms_webhook_event_worker_wakeup
AFTER INSERT ON public.pms_webhook_events
FOR EACH ROW
WHEN (
  NEW.status = 'received'
  AND NEW.event_type IN (
    'reservation.confirmed',
    'reservation.updated',
    'reservation.cancelled'
  )
)
EXECUTE FUNCTION public.wake_pms_webhook_event_worker_on_insert();

DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  SELECT jobid
  INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'pms-webhook-event-worker'
  LIMIT 1;

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;

  PERFORM cron.schedule(
    'pms-webhook-event-worker',
    '* * * * *',
    $cron$
      SELECT public.wake_pms_webhook_event_worker();
    $cron$
  );
END;
$$;

COMMIT;
