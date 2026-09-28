-- Supabase-native wake-up mechanism for the application-owned PMS initial sync.
--
-- PostgreSQL does NOT perform PMS API or CRM contact synchronization.
-- It only sends authenticated POST requests to the internal CRM worker.
--
-- The application-side DB claim remains the concurrency boundary, therefore
-- immediate trigger wake-ups and scheduled cron wake-ups may safely overlap.
--
-- After applying this migration configure these Supabase Vault secrets:
--
--   pms_sync_worker_url
--     DEV example:
--     https://dev-crm.rukiyezara.com/api/integrations/pms/sync/worker
--
--   pms_sync_worker_token
--     Must contain the same raw value as the CRM Vercel environment variable:
--     PMS_SYNC_WORKER_TOKEN
--
-- IMPORTANT:
-- The worker URL must use HTTPS.

BEGIN;


-- ============================================================
-- REQUIRED EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;


-- ============================================================
-- PMS INITIAL SYNC WORKER WAKE-UP
-- ============================================================

CREATE OR REPLACE FUNCTION public.wake_pms_initial_sync_worker()
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

  -- Read worker URL from Vault.
  SELECT decrypted_secret
  INTO worker_url
  FROM vault.decrypted_secrets
  WHERE name = 'pms_sync_worker_url'
  LIMIT 1;


  -- Read worker authentication token from Vault.
  SELECT decrypted_secret
  INTO worker_token
  FROM vault.decrypted_secrets
  WHERE name = 'pms_sync_worker_token'
  LIMIT 1;


  -- Missing configuration is intentionally a safe no-op.
  --
  -- This allows migrations/provisioning to succeed even before Vault
  -- configuration has been completed. The scheduled cron will continue
  -- attempting wake-ups once configuration is available.
  IF NULLIF(btrim(worker_url), '') IS NULL
     OR NULLIF(btrim(worker_token), '') IS NULL THEN
    RETURN NULL;
  END IF;


  -- Only HTTPS worker endpoints are allowed.
  IF worker_url !~* '^https://' THEN
    RETURN NULL;
  END IF;


  -- Queue the HTTP request asynchronously through pg_net.
  SELECT net.http_post(
    url := worker_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-pms-sync-worker-token', worker_token
    ),
    body := jsonb_build_object(
      'source', 'supabase'
    ),
    timeout_milliseconds := 5000
  )
  INTO request_id;


  RETURN request_id;

EXCEPTION
  WHEN OTHERS THEN
    -- Wake-up delivery is best effort.
    --
    -- Vault, pg_net, networking or deployment configuration failures must
    -- NEVER roll back PMS property provisioning.
    --
    -- The scheduled worker will retry automatically.
    RETURN NULL;
END;
$$;


COMMENT ON FUNCTION public.wake_pms_initial_sync_worker() IS
  'Queues an authenticated pg_net wake-up for the CRM PMS initial-sync worker. Returns NULL when configuration or delivery is unavailable.';


-- This is an internal infrastructure function.
REVOKE ALL
ON FUNCTION public.wake_pms_initial_sync_worker()
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.wake_pms_initial_sync_worker()
FROM anon;

REVOKE ALL
ON FUNCTION public.wake_pms_initial_sync_worker()
FROM authenticated;



-- ============================================================
-- IMMEDIATE WAKE-UP TRIGGER FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION public.wake_pms_initial_sync_worker_on_pending()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN

  -- Best-effort immediate wake-up.
  --
  -- The HTTP request is asynchronous because pg_net only queues the request.
  -- The CRM worker itself performs the actual PMS synchronization.
  PERFORM public.wake_pms_initial_sync_worker();

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN

    -- PMS property creation/update is authoritative.
    --
    -- A worker wake-up failure must never fail or roll back provisioning.
    RETURN NEW;

END;
$$;


COMMENT ON FUNCTION public.wake_pms_initial_sync_worker_on_pending() IS
  'Best-effort immediate CRM worker wake-up when a PMS property enters pending initial-sync state.';


REVOKE ALL
ON FUNCTION public.wake_pms_initial_sync_worker_on_pending()
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.wake_pms_initial_sync_worker_on_pending()
FROM anon;

REVOKE ALL
ON FUNCTION public.wake_pms_initial_sync_worker_on_pending()
FROM authenticated;



-- ============================================================
-- IMMEDIATE WAKE-UP ON NEW PMS PROPERTY
-- ============================================================

DROP TRIGGER IF EXISTS pms_property_initial_sync_pending_insert
ON public.pms_properties;


CREATE TRIGGER pms_property_initial_sync_pending_insert
AFTER INSERT
ON public.pms_properties
FOR EACH ROW
WHEN (
  NEW.initial_sync_status = 'pending'
)
EXECUTE FUNCTION public.wake_pms_initial_sync_worker_on_pending();



-- ============================================================
-- IMMEDIATE WAKE-UP WHEN PROPERTY RETURNS TO PENDING
-- ============================================================

DROP TRIGGER IF EXISTS pms_property_initial_sync_pending_update
ON public.pms_properties;


CREATE TRIGGER pms_property_initial_sync_pending_update
AFTER UPDATE OF initial_sync_status
ON public.pms_properties
FOR EACH ROW
WHEN (
  OLD.initial_sync_status IS DISTINCT FROM NEW.initial_sync_status
  AND NEW.initial_sync_status = 'pending'
)
EXECUTE FUNCTION public.wake_pms_initial_sync_worker_on_pending();



-- ============================================================
-- SCHEDULED RECOVERY WORKER
-- ============================================================
--
-- Runs every minute.
--
-- Purpose:
--   - pick up pending properties if immediate wake-up failed
--   - retry failed properties according to application worker logic
--   - recover stale "syncing" properties according to the application claim
--     implementation
--
-- The worker's DB claim prevents overlapping wake-ups from processing the
-- same property concurrently.
--
-- Scheduling is made deterministic so the migration cannot accidentally
-- leave duplicate jobs with the same purpose.


DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN

  SELECT jobid
  INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'pms-initial-sync-worker'
  LIMIT 1;


  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;


  PERFORM cron.schedule(
    'pms-initial-sync-worker',
    '* * * * *',
    $cron$
      SELECT public.wake_pms_initial_sync_worker();
    $cron$
  );

END;
$$;


COMMIT;