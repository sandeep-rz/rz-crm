-- PMS contact recovery checkpoint for booking-triggered automations.
-- This migration preserves the existing PMS reservation and guest-sync logic.
BEGIN;

ALTER TABLE public.automation_pending_executions
  DROP CONSTRAINT automation_pending_executions_status_check;
ALTER TABLE public.automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending','running','done','failed','blocked_contact'));
ALTER TABLE public.automation_pending_executions
  ADD COLUMN IF NOT EXISTS blocked_step_id uuid,
  ADD COLUMN IF NOT EXISTS blocked_step_type text,
  ADD COLUMN IF NOT EXISTS pms_reservation_id uuid,
  ADD COLUMN IF NOT EXISTS contact_recovery_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS automation_pending_contact_recovery_due_idx
  ON public.automation_pending_executions (next_attempt_at, id)
  WHERE status = 'blocked_contact';

CREATE OR REPLACE FUNCTION public.wake_pms_contact_continuations(
  p_now timestamptz DEFAULT now()
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  WITH picked AS (
    SELECT p.id, p.account_id, p.log_id, p.automation_id,
      CASE
        WHEN p.contact_recovery_expires_at <= p_now THEN 'expired'
        WHEN NOT a.is_active THEN 'inactive'
        WHEN i.status <> 'connected' OR prop.status <> 'active' THEN 'disconnected'
        WHEN r.status IN ('cancelled','canceled') AND a.trigger_type <> 'reservation_cancelled'
          THEN 'cancelled'
        WHEN c.phone_normalized ~ '^[1-9][0-9]{7,14}$' THEN 'ready'
        ELSE 'blocked'
      END AS outcome
    FROM public.automation_pending_executions p
    JOIN public.automations a ON a.id = p.automation_id AND a.account_id = p.account_id
    JOIN public.pms_reservations r ON r.id = p.pms_reservation_id AND r.account_id = p.account_id
    JOIN public.pms_integrations i ON i.id = r.pms_integration_id AND i.account_id = p.account_id
    JOIN public.pms_properties prop ON prop.id = r.pms_property_id
      AND prop.account_id = p.account_id AND prop.pms_integration_id = i.id
    LEFT JOIN public.contacts c ON c.id = r.contact_id AND c.account_id = p.account_id
    WHERE p.status = 'blocked_contact' AND p.next_attempt_at <= p_now
    ORDER BY p.next_attempt_at, p.id
    LIMIT 100 FOR UPDATE OF p SKIP LOCKED
  ), changed AS (
    UPDATE public.automation_pending_executions p
    SET status = CASE WHEN picked.outcome='ready' THEN 'pending'
                      WHEN picked.outcome='blocked' THEN 'blocked_contact'
                      ELSE 'failed' END,
        next_attempt_at = CASE WHEN picked.outcome='ready' THEN greatest(p.run_at,p_now)
                               WHEN picked.outcome='blocked' THEN
                                 least(p.contact_recovery_expires_at,p_now + interval '1 minute')
                               ELSE NULL END,
        last_error = CASE WHEN picked.outcome='blocked' THEN 'missing_or_invalid_guest_phone'
                          WHEN picked.outcome='ready' THEN NULL
                          ELSE 'contact_recovery_' || picked.outcome END
    FROM picked
    WHERE p.id=picked.id AND p.account_id=picked.account_id
    RETURNING p.log_id,p.account_id,p.automation_id,p.status,p.last_error
  )
  UPDATE public.automation_logs l
  SET status='failed',error_message=changed.last_error
  FROM changed
  WHERE changed.status='failed' AND l.id=changed.log_id
    AND l.account_id=changed.account_id AND l.automation_id=changed.automation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.park_pms_contact_continuation(
  p_account_id uuid, p_automation_id uuid, p_log_id uuid, p_reservation_id uuid,
  p_step_id uuid, p_context jsonb, p_trigger_job_id uuid, p_pending_id uuid,
  p_attempt integer, p_expiry_hours integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  job public.automation_trigger_jobs%ROWTYPE;
  pending public.automation_pending_executions%ROWTYPE;
  log_row public.automation_logs%ROWTYPE;
  step_row public.automation_steps%ROWTYPE;
  due_at timestamptz;
  expiry timestamptz;
BEGIN
  IF (p_trigger_job_id IS NULL) = (p_pending_id IS NULL)
    OR p_expiry_hours NOT BETWEEN 1 AND 720 THEN RETURN false; END IF;

  IF p_trigger_job_id IS NOT NULL THEN
    SELECT * INTO job FROM public.automation_trigger_jobs j
    WHERE j.id=p_trigger_job_id AND j.account_id=p_account_id
      AND j.automation_id=p_automation_id AND j.pms_reservation_id=p_reservation_id
      AND j.status='processing' AND j.attempt_count=p_attempt
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    due_at := job.run_at;
  ELSE
    SELECT * INTO pending FROM public.automation_pending_executions p
    WHERE p.id=p_pending_id AND p.account_id=p_account_id
      AND p.automation_id=p_automation_id AND p.log_id=p_log_id
      AND p.status='running' AND p.attempt_count=p_attempt
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    due_at := pending.run_at;
  END IF;

  SELECT * INTO log_row FROM public.automation_logs l
  WHERE l.id=p_log_id AND l.account_id=p_account_id
    AND l.automation_id=p_automation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_trigger_job_id IS NOT NULL AND
    (log_row.trigger_job_id IS DISTINCT FROM p_trigger_job_id
      OR log_row.trigger_job_attempt_count IS DISTINCT FROM p_attempt
      OR log_row.trigger_job_execution_state <> 'processing') THEN
    RETURN false;
  END IF;
  IF p_pending_id IS NOT NULL AND p_pending_id=ANY(log_row.completed_wait_continuation_ids)
    THEN RETURN false; END IF;
  IF log_row.retry_safety->>'step_id' = p_step_id::text
    OR pending.context #>> '{__retry_safety,step_id}' = p_step_id::text
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(log_row.steps_executed,'[]'::jsonb)) s
      WHERE s->>'step_id'=p_step_id::text AND s->>'status'='success'
    ) THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.automation_trigger_jobs j
    WHERE j.id=log_row.trigger_job_id AND j.pms_reservation_id=p_reservation_id
      AND j.account_id=p_account_id AND j.automation_id=p_automation_id
  ) THEN RETURN false; END IF;

  SELECT * INTO step_row FROM public.automation_steps s
  WHERE s.id=p_step_id AND s.automation_id=p_automation_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF step_row.step_type NOT IN
    ('send_template','send_message','send_buttons','send_list','add_tag',
     'remove_tag','assign_conversation','update_contact_field','create_deal')
     THEN RETURN false; END IF;

  expiry := coalesce(pending.contact_recovery_expires_at,
    due_at + make_interval(hours=>p_expiry_hours));
  IF expiry <= now() THEN RETURN false; END IF;

  IF p_pending_id IS NULL THEN
    INSERT INTO public.automation_pending_executions (
      account_id,automation_id,user_id,contact_id,log_id,context,
      parent_step_id,branch,next_step_position,run_at,status,next_attempt_at,
      last_error,blocked_step_id,blocked_step_type,pms_reservation_id,
      contact_recovery_expires_at
    ) VALUES (
      p_account_id,p_automation_id,log_row.user_id,log_row.contact_id,p_log_id,
      p_context - '__retry_safety',step_row.parent_step_id,step_row.branch,
      step_row.position,due_at,'blocked_contact',now(),'missing_or_invalid_guest_phone',
      p_step_id,step_row.step_type,p_reservation_id,expiry
    );
    UPDATE public.automation_trigger_jobs SET status='completed',
      completed_at=now(),processing_started_at=NULL,next_attempt_at=NULL,
      retryable=false,last_error=NULL
    WHERE id=job.id AND account_id=p_account_id;
  ELSE
    UPDATE public.automation_pending_executions
    SET context=p_context - '__retry_safety',parent_step_id=step_row.parent_step_id,
      branch=step_row.branch,next_step_position=step_row.position,parked_step_id=NULL,
      blocked_step_id=p_step_id,blocked_step_type=step_row.step_type,
      pms_reservation_id=p_reservation_id,contact_recovery_expires_at=expiry,
      processing_started_at=NULL,status='blocked_contact',next_attempt_at=now(),
      last_error='missing_or_invalid_guest_phone'
    WHERE id=pending.id AND account_id=p_account_id;
  END IF;
  UPDATE public.automation_logs SET status='partial',
    error_message='missing_or_invalid_guest_phone',
    trigger_job_execution_state='completed'
  WHERE id=p_log_id AND account_id=p_account_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_automation_pending_with_contact_recovery(
  p_batch_size integer,p_now timestamptz,p_stale_before timestamptz,p_max_attempts integer
) RETURNS SETOF public.automation_pending_executions
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.wake_pms_contact_continuations(p_now);
  RETURN QUERY SELECT * FROM public.claim_automation_pending_executions(
    p_batch_size,p_now,p_stale_before,p_max_attempts);
END;
$$;

REVOKE ALL ON FUNCTION public.wake_pms_contact_continuations(timestamptz)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.park_pms_contact_continuation(uuid,uuid,uuid,uuid,uuid,jsonb,uuid,uuid,integer,integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_automation_pending_with_contact_recovery(integer,timestamptz,timestamptz,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.wake_pms_contact_continuations(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.park_pms_contact_continuation(uuid,uuid,uuid,uuid,uuid,jsonb,uuid,uuid,integer,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_automation_pending_with_contact_recovery(integer,timestamptz,timestamptz,integer)
  TO service_role;
COMMIT;
