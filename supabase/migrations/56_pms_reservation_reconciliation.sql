-- Durable periodic PMS reservation reconciliation.
--
-- PostgreSQL owns only durable lease/state transitions and the pg_net wake-up.
-- Provider HTTP calls and CRM projection remain application responsibilities.
--
-- Configure this additional Vault secret after applying the migration:
--   pms_reconciliation_worker_url =
--     https://crm.example.com/api/integrations/pms/reconciliation/worker
--
-- The existing pms_sync_worker_token Vault secret is reused and must match the
-- CRM deployment's PMS_SYNC_WORKER_TOKEN environment variable.

BEGIN;

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

ALTER TABLE public.pms_properties
  ADD COLUMN last_reconciled_at TIMESTAMPTZ,
  ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (reconciliation_status IN ('pending', 'processing', 'completed', 'failed')),
  ADD COLUMN reconciliation_started_at TIMESTAMPTZ,
  ADD COLUMN last_reconciliation_error TEXT,
  ADD COLUMN reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (reconciliation_attempt_count >= 0),
  ADD COLUMN reconciliation_next_attempt_at TIMESTAMPTZ;

CREATE INDEX idx_pms_properties_reconciliation_claim
  ON public.pms_properties(
    reconciliation_status,
    reconciliation_next_attempt_at,
    last_reconciled_at
  )
  WHERE status = 'active';

COMMENT ON COLUMN public.pms_properties.last_reconciled_at IS
  'Successful completion watermark. It advances only after every provider page has been projected.';
COMMENT ON COLUMN public.pms_properties.reconciliation_started_at IS
  'Lease start for the current application reconciliation claim; stale leases may be reclaimed.';
COMMENT ON COLUMN public.pms_properties.reconciliation_attempt_count IS
  'Monotonic lease generation used to fence stale application workers.';
COMMENT ON COLUMN public.pms_properties.reconciliation_next_attempt_at IS
  'Earliest time a failed reconciliation may be claimed again.';

-- Atomically lease a bounded batch. The integration join both supplies trusted
-- provider context and excludes disconnected integrations at the claim edge.
CREATE OR REPLACE FUNCTION public.claim_pms_reconciliation_properties(
  p_limit INTEGER,
  p_due_before TIMESTAMPTZ,
  p_stale_before TIMESTAMPTZ,
  p_now TIMESTAMPTZ
)
RETURNS TABLE (
  property_id UUID,
  account_id UUID,
  pms_integration_id UUID,
  external_property_id TEXT,
  provider TEXT,
  external_account_id TEXT,
  reconciliation_started_at TIMESTAMPTZ,
  reconciliation_attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'PMS reconciliation claim limit must be between 1 and 50.';
  END IF;
  IF p_due_before IS NULL OR p_stale_before IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'PMS reconciliation claim timestamps are required.';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT property.id
    FROM public.pms_properties AS property
    INNER JOIN public.pms_integrations AS integration
      ON integration.id = property.pms_integration_id
     AND integration.account_id = property.account_id
     AND integration.status = 'connected'
    WHERE property.status = 'active'
      AND (
        (
          property.reconciliation_status = 'processing'
          AND (
            property.reconciliation_started_at IS NULL
            OR property.reconciliation_started_at <= p_stale_before
          )
        )
        OR (
          property.reconciliation_status <> 'processing'
          AND (
            property.reconciliation_next_attempt_at IS NULL
            OR property.reconciliation_next_attempt_at <= p_now
          )
          AND (
            property.last_reconciled_at IS NULL
            OR property.last_reconciled_at <= p_due_before
          )
        )
      )
    ORDER BY property.last_reconciled_at ASC NULLS FIRST, property.created_at ASC
    FOR UPDATE OF property SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.pms_properties AS property
    SET
      reconciliation_status = 'processing',
      reconciliation_started_at = p_now,
      last_reconciliation_error = NULL,
      reconciliation_next_attempt_at = NULL,
      reconciliation_attempt_count = property.reconciliation_attempt_count + 1
    FROM candidates
    WHERE property.id = candidates.id
    RETURNING
      property.id,
      property.account_id,
      property.pms_integration_id,
      property.external_property_id,
      property.reconciliation_started_at,
      property.reconciliation_attempt_count
  )
  SELECT
    claimed.id,
    claimed.account_id,
    claimed.pms_integration_id,
    claimed.external_property_id,
    integration.provider,
    integration.external_account_id,
    claimed.reconciliation_started_at,
    claimed.reconciliation_attempt_count
  FROM claimed
  INNER JOIN public.pms_integrations AS integration
    ON integration.id = claimed.pms_integration_id
   AND integration.account_id = claimed.account_id
   AND integration.status = 'connected';
END;
$$;

REVOKE ALL
ON FUNCTION public.claim_pms_reconciliation_properties(
  INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.claim_pms_reconciliation_properties(
  INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
)
TO service_role;

COMMENT ON FUNCTION public.claim_pms_reconciliation_properties(
  INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) IS
  'Atomically leases due or stale active properties whose PMS integration is connected.';

CREATE OR REPLACE FUNCTION public.wake_pms_reconciliation_worker()
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
  WHERE name = 'pms_reconciliation_worker_url'
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
    -- Wake-up delivery is best effort; the next six-hour cron remains durable.
    RETURN NULL;
END;
$$;

REVOKE ALL
ON FUNCTION public.wake_pms_reconciliation_worker()
FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.wake_pms_reconciliation_worker() IS
  'Queues a best-effort authenticated pg_net wake-up for the application reconciliation worker.';

-- Re-applying the migration cannot create a duplicate named job. Use the
-- supported cron functions rather than directly mutating cron.job.
DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  SELECT jobid
  INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'pms-reservation-reconciliation'
  LIMIT 1;

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;

  PERFORM cron.schedule(
    'pms-reservation-reconciliation',
    '0 */6 * * *',
    $cron$
      SELECT public.wake_pms_reconciliation_worker();
    $cron$
  );
END;
$$;

COMMIT;
