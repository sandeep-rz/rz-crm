-- Tie each successfully completed Wait continuation to its stable pending-row
-- identity. This lets a stale lease recovery distinguish a completed segment
-- from one that still needs to run, without changing either automation queue.

ALTER TABLE public.automation_logs
  ADD COLUMN IF NOT EXISTS completed_wait_continuation_ids UUID[]
  NOT NULL DEFAULT '{}'::UUID[];

COMMENT ON COLUMN public.automation_logs.completed_wait_continuation_ids IS
  'Stable automation_pending_executions ids whose resumed segments completed successfully.';

CREATE OR REPLACE FUNCTION public.complete_automation_wait_continuation(
  p_log_id UUID,
  p_pending_execution_id UUID,
  p_account_id UUID,
  p_automation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_marked BOOLEAN := FALSE;
BEGIN
  UPDATE public.automation_logs AS log
  SET completed_wait_continuation_ids = array_append(
        log.completed_wait_continuation_ids,
        p_pending_execution_id
      )
  WHERE log.id = p_log_id
    AND log.account_id = p_account_id
    AND log.automation_id = p_automation_id
    AND NOT (p_pending_execution_id = ANY(log.completed_wait_continuation_ids))
  RETURNING TRUE INTO v_marked;

  IF v_marked THEN
    RETURN TRUE;
  END IF;

  -- Idempotent success for a repeated completion call; false only means the
  -- supplied log/account/automation relationship was invalid.
  RETURN EXISTS (
    SELECT 1
    FROM public.automation_logs AS log
    WHERE log.id = p_log_id
      AND log.account_id = p_account_id
      AND log.automation_id = p_automation_id
      AND p_pending_execution_id = ANY(log.completed_wait_continuation_ids)
  );
END;
$$;

ALTER FUNCTION public.complete_automation_wait_continuation(UUID, UUID, UUID, UUID)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.complete_automation_wait_continuation(UUID, UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.complete_automation_wait_continuation(UUID, UUID, UUID, UUID)
  TO service_role;
