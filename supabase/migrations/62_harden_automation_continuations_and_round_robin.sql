-- Harden Wait continuations with atomic leases/retries, and make conversation
-- round-robin assignment durable and workspace-scoped.

ALTER TABLE public.automation_pending_executions
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_automation_pending_retry_due
  ON public.automation_pending_executions (
    (COALESCE(next_attempt_at, run_at)),
    created_at
  )
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_automation_pending_stale_running
  ON public.automation_pending_executions (processing_started_at)
  WHERE status = 'running';

CREATE OR REPLACE FUNCTION public.claim_automation_pending_executions(
  p_batch_size INTEGER,
  p_now TIMESTAMPTZ,
  p_stale_before TIMESTAMPTZ,
  p_max_attempts INTEGER
)
RETURNS SETOF public.automation_pending_executions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 100 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 100';
  END IF;
  IF p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION 'max attempts must be between 1 and 20';
  END IF;

  -- A worker can die after its final claim. Make that row terminal once its
  -- lease expires instead of leaving it running forever.
  UPDATE public.automation_pending_executions AS exhausted
  SET status = 'failed',
      processing_started_at = NULL,
      last_error = COALESCE(exhausted.last_error, 'continuation lease expired after final attempt')
  WHERE exhausted.status = 'running'
    AND exhausted.processing_started_at < p_stale_before
    AND exhausted.attempt_count >= p_max_attempts;

  RETURN QUERY
  WITH candidates AS (
    SELECT candidate.id
    FROM public.automation_pending_executions AS candidate
    WHERE candidate.attempt_count < p_max_attempts
      AND (
        (
          candidate.status = 'pending'
          AND COALESCE(candidate.next_attempt_at, candidate.run_at) <= p_now
        )
        OR (
          candidate.status = 'running'
          AND candidate.processing_started_at < p_stale_before
        )
      )
    ORDER BY COALESCE(candidate.next_attempt_at, candidate.run_at), candidate.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.automation_pending_executions AS pending
  SET status = 'running',
      processing_started_at = p_now,
      attempt_count = pending.attempt_count + 1,
      next_attempt_at = NULL
  FROM candidates
  WHERE pending.id = candidates.id
  RETURNING pending.*;
END;
$$;

ALTER FUNCTION public.claim_automation_pending_executions(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.claim_automation_pending_executions(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.claim_automation_pending_executions(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  TO service_role;

CREATE TABLE IF NOT EXISTS public.automation_round_robin_state (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  last_assigned_user_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.automation_round_robin_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_round_robin_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.automation_round_robin_state TO service_role;

CREATE OR REPLACE FUNCTION public.claim_automation_round_robin_assignee(
  p_account_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_last UUID;
  v_next UUID;
BEGIN
  INSERT INTO public.automation_round_robin_state (account_id)
  VALUES (p_account_id)
  ON CONFLICT (account_id) DO NOTHING;

  SELECT state.last_assigned_user_id
  INTO v_last
  FROM public.automation_round_robin_state AS state
  WHERE state.account_id = p_account_id
  FOR UPDATE;

  -- Existing product semantics consider every account membership eligible.
  -- UUID order is stable, and wrapping produces A -> B -> C -> A behavior.
  SELECT member.user_id
  INTO v_next
  FROM public.account_members AS member
  WHERE member.account_id = p_account_id
    AND (v_last IS NULL OR member.user_id > v_last)
  ORDER BY member.user_id
  LIMIT 1;

  IF v_next IS NULL THEN
    SELECT member.user_id
    INTO v_next
    FROM public.account_members AS member
    WHERE member.account_id = p_account_id
    ORDER BY member.user_id
    LIMIT 1;
  END IF;

  UPDATE public.automation_round_robin_state
  SET last_assigned_user_id = v_next,
      updated_at = now()
  WHERE account_id = p_account_id;

  RETURN v_next;
END;
$$;

ALTER FUNCTION public.claim_automation_round_robin_assignee(UUID)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.claim_automation_round_robin_assignee(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.claim_automation_round_robin_assignee(UUID)
  TO service_role;
