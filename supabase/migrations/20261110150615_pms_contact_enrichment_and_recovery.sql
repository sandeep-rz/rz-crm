BEGIN;

ALTER TABLE public.pms_contact_external_identities
  ADD COLUMN source_updated_at timestamptz;
ALTER TABLE public.pms_reservations ADD COLUMN contact_snapshot_synced boolean NOT NULL DEFAULT false;

-- Reservation.updated_at also fences automation scheduling and execution.
-- A transaction may wait on the account lock, so its start time is not a
-- monotonic write version.
CREATE FUNCTION public.stamp_pms_reservation_projection_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_pms_reservation_projection_version()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER set_pms_reservations_updated_at ON public.pms_reservations;
CREATE TRIGGER set_pms_reservations_updated_at BEFORE UPDATE ON public.pms_reservations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_pms_reservation_projection_version();

CREATE INDEX contacts_pms_email_lookup
  ON public.contacts (account_id, lower(email)) WHERE email IS NOT NULL;

ALTER TABLE public.automation_pending_executions
  DROP CONSTRAINT automation_pending_executions_status_check,
  ADD CONSTRAINT automation_pending_executions_status_check
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'blocked_contact')),
  ADD COLUMN IF NOT EXISTS parked_step_id uuid,
  ADD COLUMN blocked_step_id uuid,
  ADD COLUMN blocked_step_type text,
  ADD COLUMN pms_reservation_id uuid,
  ADD COLUMN contact_recovery_expires_at timestamptz,
  ADD CONSTRAINT automation_pending_pms_reservation_account_fkey
    FOREIGN KEY (pms_reservation_id, account_id)
    REFERENCES public.pms_reservations (id, account_id) ON DELETE CASCADE,
  ADD CONSTRAINT automation_pending_contact_block_shape CHECK (
    status <> 'blocked_contact' OR (
      blocked_step_id IS NOT NULL AND blocked_step_type IS NOT NULL AND pms_reservation_id IS NOT NULL
      AND contact_recovery_expires_at IS NOT NULL AND next_attempt_at IS NOT NULL
    )
  );

CREATE INDEX automation_pending_contact_poll_idx
  ON public.automation_pending_executions (next_attempt_at, id)
  WHERE status = 'blocked_contact';
CREATE INDEX automation_pending_contact_wake_idx
  ON public.automation_pending_executions (account_id, pms_reservation_id, next_attempt_at, id)
  WHERE status = 'blocked_contact';
CREATE INDEX automation_pending_pms_reservation_fk_idx
  ON public.automation_pending_executions (pms_reservation_id, account_id)
  WHERE pms_reservation_id IS NOT NULL;

-- Advance only parked contact cursors. A bounded, ordered poll rotates past
-- still-blocked rows; enrichment can wake a single reservation immediately.
CREATE FUNCTION public.wake_pms_contact_continuations(
  p_account_id uuid, p_reservation_id uuid, p_now timestamptz
) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (p_account_id IS NULL) <> (p_reservation_id IS NULL) THEN
    RAISE EXCEPTION 'Contact wake requires both account and reservation';
  END IF;

  WITH picked AS (
    SELECT p.id, p.account_id, p.log_id, p.automation_id,
      CASE
        WHEN p.contact_recovery_expires_at <= p_now THEN 'contact_recovery_expired'
        WHEN NOT a.is_active THEN 'automation_inactive'
        WHEN i.status <> 'connected' OR property.status <> 'active' THEN 'pms_connection_inactive'
        WHEN r.status IN ('cancelled', 'canceled') AND a.trigger_type <> 'reservation_cancelled'
          THEN 'reservation_cancelled'
        WHEN c.phone_normalized <> '' AND c.phone_normalized ~ '^[1-9][0-9]{7,14}$'
          THEN 'ready'
        ELSE 'blocked'
      END AS outcome
    FROM public.automation_pending_executions p
    JOIN public.automations a ON a.id = p.automation_id AND a.account_id = p.account_id
    JOIN public.pms_reservations r ON r.id = p.pms_reservation_id AND r.account_id = p.account_id
    JOIN public.pms_integrations i ON i.id = r.pms_integration_id AND i.account_id = p.account_id
    JOIN public.pms_properties property ON property.id = r.pms_property_id
      AND property.pms_integration_id = i.id AND property.account_id = p.account_id
    LEFT JOIN public.contacts c ON c.id = r.contact_id AND c.account_id = p.account_id
    WHERE p.status = 'blocked_contact'
      AND (
        (p_reservation_id IS NULL AND p.next_attempt_at <= p_now)
        OR (p.account_id = p_account_id AND p.pms_reservation_id = p_reservation_id)
      )
    ORDER BY p.next_attempt_at, p.id
    LIMIT 100
    FOR UPDATE OF p SKIP LOCKED
  ), changed AS (
    UPDATE public.automation_pending_executions p
    SET status = CASE picked.outcome
          WHEN 'blocked' THEN 'blocked_contact'
          WHEN 'ready' THEN 'pending'
          ELSE 'failed'
        END,
        next_attempt_at = CASE picked.outcome
          WHEN 'blocked' THEN least(p.contact_recovery_expires_at, p_now + interval '1 minute')
          WHEN 'ready' THEN greatest(p.run_at, p_now)
          ELSE NULL
        END,
        last_error = CASE WHEN picked.outcome IN ('blocked', 'ready')
          THEN p.last_error ELSE picked.outcome END
    FROM picked
    WHERE p.id = picked.id AND p.account_id = picked.account_id
    RETURNING p.log_id, p.account_id, p.automation_id, p.status, p.last_error
  )
  UPDATE public.automation_logs l
  SET status = 'failed', error_message = changed.last_error
  FROM changed
  WHERE changed.status = 'failed' AND l.id = changed.log_id
    AND l.account_id = changed.account_id AND l.automation_id = changed.automation_id;
END;
$$;

-- A snapshot, contact mutations, identity mapping and reservation linkage
-- commit together. The account lock serializes PMS match/create (including
-- phone-less identities and email matches) across integrations in the account.
CREATE FUNCTION public.sync_pms_reservation_contact(
  p_account_id uuid, p_integration_id uuid, p_property_id uuid,
  p_external_property_id text, p_provider text, p_guest jsonb, p_reservation jsonb
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  incoming public.pms_reservations%ROWTYPE;
  existing public.pms_reservations%ROWTYPE;
  identity_row public.pms_contact_external_identities%ROWTYPE;
  contact_id_value uuid;
  phone_match uuid;
  email_match uuid;
  email_count integer;
  audit_id uuid;
  new_contact boolean := false;
  mapped boolean := false;
  reservation_id_value uuid;
  guest_phone text := p_guest->>'phone';
  guest_email text := p_guest->>'email';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pms_properties p
    JOIN public.pms_integrations i ON i.id = p.pms_integration_id AND i.account_id = p.account_id
    WHERE p.id = p_property_id AND p.account_id = p_account_id
      AND i.id = p_integration_id AND i.provider = p_provider
      AND p.external_property_id = p_external_property_id
  ) THEN
    RAISE EXCEPTION 'Invalid PMS integration/property relationship';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pms-contact:' || p_account_id::text, 0));

  incoming := jsonb_populate_record(NULL::public.pms_reservations, p_reservation);
  SELECT * INTO existing FROM public.pms_reservations r
    WHERE r.account_id = p_account_id AND r.pms_integration_id = p_integration_id
      AND r.external_reservation_id = incoming.external_reservation_id
    FOR NO KEY UPDATE;

  IF existing.external_updated_at IS NOT NULL
    AND (incoming.external_updated_at IS NULL OR incoming.external_updated_at < existing.external_updated_at
      OR (existing.contact_snapshot_synced AND incoming.external_updated_at = existing.external_updated_at))
  THEN
    RETURN jsonb_build_object('reservationId', existing.id, 'contactId', existing.contact_id,
      'contactCreated', false, 'externalGuestMapped', false, 'skippedStale', true);
  END IF;

  incoming.external_guest_id := coalesce(incoming.external_guest_id, existing.external_guest_id);
  IF incoming.external_guest_id IS NOT NULL THEN
    SELECT * INTO identity_row FROM public.pms_contact_external_identities m
    WHERE m.account_id = p_account_id AND m.pms_integration_id = p_integration_id
      AND m.external_guest_id = incoming.external_guest_id;
  END IF;

  -- Reuse the linked contact for providers without a guest ID. A changed
  -- stable guest identity, however, must not overwrite the previous guest.
  contact_id_value := coalesce(identity_row.contact_id,
    CASE WHEN existing.external_guest_id IS NULL OR existing.external_guest_id = incoming.external_guest_id
      THEN existing.contact_id END);

  IF identity_row.source_updated_at IS NULL OR incoming.external_updated_at >= identity_row.source_updated_at THEN
    IF guest_phone IS NOT NULL THEN
      SELECT c.id INTO phone_match FROM public.contacts c
      WHERE c.account_id = p_account_id AND c.phone_normalized <> ''
        AND c.phone_normalized = substr(guest_phone, 2);
      -- The normalized number already belongs to a contact. Link to it
      -- rather than replacing that contact or creating a duplicate.
      contact_id_value := coalesce(phone_match, contact_id_value);
    END IF;
    IF contact_id_value IS NULL AND guest_email IS NOT NULL THEN
      SELECT count(*), (array_agg(matches.id))[1] INTO email_count, email_match
      FROM (
        SELECT c.id FROM public.contacts c
        WHERE c.account_id = p_account_id AND c.email IS NOT NULL AND lower(c.email) = guest_email
        LIMIT 2
      ) matches;
      IF email_count = 1 THEN contact_id_value := email_match; END IF;
    END IF;

    IF contact_id_value IS NULL AND (guest_phone IS NOT NULL
      OR incoming.external_guest_id IS NOT NULL OR (guest_email IS NOT NULL AND email_count = 0))
    THEN
      SELECT coalesce(
        (SELECT w.user_id FROM public.whatsapp_config w
          WHERE w.account_id = p_account_id AND w.is_primary LIMIT 1),
        (SELECT a.owner_user_id FROM public.accounts a WHERE a.id = p_account_id)
      ) INTO audit_id;
      INSERT INTO public.contacts (account_id, user_id, phone, name, email)
      VALUES (p_account_id, audit_id, coalesce(guest_phone, ''), p_guest->>'name',
        CASE WHEN email_count = 2 THEN NULL ELSE guest_email END)
      ON CONFLICT (account_id, phone_normalized) WHERE phone_normalized <> '' DO NOTHING
      RETURNING id INTO contact_id_value;
      new_contact := FOUND;
      IF NOT new_contact THEN
        SELECT c.id INTO STRICT contact_id_value FROM public.contacts c
        WHERE c.account_id = p_account_id AND c.phone_normalized = substr(guest_phone, 2);
      END IF;
    END IF;

    IF contact_id_value IS NOT NULL THEN
      UPDATE public.contacts c SET
        phone = CASE WHEN p_guest ? 'phone' THEN coalesce(guest_phone, '') ELSE c.phone END,
        name = CASE WHEN p_guest ? 'name' THEN p_guest->>'name' ELSE c.name END,
        email = CASE WHEN p_guest ? 'email' AND email_count IS DISTINCT FROM 2 THEN guest_email ELSE c.email END
      WHERE c.id = contact_id_value AND c.account_id = p_account_id
        AND ((p_guest ? 'phone' AND c.phone IS DISTINCT FROM coalesce(guest_phone, ''))
          OR (p_guest ? 'name' AND c.name IS DISTINCT FROM p_guest->>'name')
          OR (p_guest ? 'email' AND email_count IS DISTINCT FROM 2 AND c.email IS DISTINCT FROM guest_email));

      IF incoming.external_guest_id IS NOT NULL THEN
        INSERT INTO public.pms_contact_external_identities
          (account_id, pms_integration_id, contact_id, external_guest_id, source_updated_at)
        VALUES (p_account_id, p_integration_id, contact_id_value,
          incoming.external_guest_id, incoming.external_updated_at)
        ON CONFLICT (pms_integration_id, external_guest_id) DO UPDATE
        SET contact_id = EXCLUDED.contact_id, source_updated_at = EXCLUDED.source_updated_at
        WHERE pms_contact_external_identities.account_id = EXCLUDED.account_id;
        mapped := true;
      END IF;
    END IF;
  ELSE
    mapped := identity_row.contact_id IS NOT NULL;
  END IF;

  IF existing.id IS NULL THEN
    INSERT INTO public.pms_reservations (
      account_id, pms_integration_id, pms_property_id, contact_id, external_reservation_id,
      external_guest_id, external_listing_id, reservation_code, status, provider_status,
      check_in, check_out, adults, children, infants, pets, occupancy_total, channel_code,
      channel_name, total_amount, paid_amount, balance_due, currency, payment_status,
      external_created_at, external_updated_at, metadata, last_synced_at, contact_snapshot_synced
    ) VALUES (
      p_account_id, p_integration_id, p_property_id, contact_id_value, incoming.external_reservation_id,
      incoming.external_guest_id, incoming.external_listing_id, incoming.reservation_code,
      incoming.status, incoming.provider_status, incoming.check_in, incoming.check_out,
      incoming.adults, incoming.children, incoming.infants, incoming.pets, incoming.occupancy_total,
      incoming.channel_code, incoming.channel_name, incoming.total_amount, incoming.paid_amount,
      incoming.balance_due, incoming.currency, incoming.payment_status, incoming.external_created_at,
      incoming.external_updated_at, incoming.metadata, now(), true
    ) RETURNING id INTO reservation_id_value;
  ELSE
    reservation_id_value := existing.id;
    -- Avoid bumping the reservation execution gate on identical snapshots.
    IF NOT existing.contact_snapshot_synced OR ROW(existing.pms_property_id, existing.contact_id, existing.external_guest_id,
      existing.external_listing_id, existing.reservation_code, existing.status, existing.provider_status,
      existing.check_in, existing.check_out, existing.adults, existing.children, existing.infants,
      existing.pets, existing.occupancy_total, existing.channel_code, existing.channel_name,
      existing.total_amount, existing.paid_amount, existing.balance_due, existing.currency,
      existing.payment_status, existing.external_updated_at, existing.metadata)
    IS DISTINCT FROM ROW(p_property_id, contact_id_value, incoming.external_guest_id,
      incoming.external_listing_id, incoming.reservation_code, incoming.status, incoming.provider_status,
      incoming.check_in, incoming.check_out, incoming.adults, incoming.children, incoming.infants,
      incoming.pets, incoming.occupancy_total, incoming.channel_code, incoming.channel_name,
      incoming.total_amount, incoming.paid_amount, incoming.balance_due, incoming.currency,
      incoming.payment_status, incoming.external_updated_at, incoming.metadata) THEN
      UPDATE public.pms_reservations SET
        pms_property_id = p_property_id, contact_id = contact_id_value,
        external_guest_id = incoming.external_guest_id, external_listing_id = incoming.external_listing_id,
        reservation_code = incoming.reservation_code, status = incoming.status,
        provider_status = incoming.provider_status, check_in = incoming.check_in, check_out = incoming.check_out,
        adults = incoming.adults, children = incoming.children, infants = incoming.infants, pets = incoming.pets,
        occupancy_total = incoming.occupancy_total, channel_code = incoming.channel_code,
        channel_name = incoming.channel_name, total_amount = incoming.total_amount,
        paid_amount = incoming.paid_amount, balance_due = incoming.balance_due,
        currency = incoming.currency, payment_status = incoming.payment_status,
        external_created_at = coalesce(existing.external_created_at, incoming.external_created_at),
        external_updated_at = incoming.external_updated_at, metadata = incoming.metadata, last_synced_at = now(),
        contact_snapshot_synced = true
      WHERE id = existing.id AND account_id = p_account_id;
    END IF;
  END IF;

  PERFORM public.wake_pms_contact_continuations(p_account_id, reservation_id_value, now());
  RETURN jsonb_build_object('reservationId', reservation_id_value, 'contactId', contact_id_value,
    'contactCreated', new_contact, 'externalGuestMapped', mapped, 'skippedStale', false);
END;
$$;

-- Checkpoint only a pre-send contact failure. For a resumed segment, keep
-- its row, original due time and attempt count. Prior side-effect evidence
-- remains on the log; the continuation latch can be cleared because its
-- cursor moves past all completed actions in the same transaction.
CREATE FUNCTION public.park_pms_contact_continuation(
  p_account_id uuid, p_automation_id uuid, p_log_id uuid, p_reservation_id uuid,
  p_step_id uuid, p_context jsonb, p_results jsonb,
  p_trigger_job_id uuid, p_pending_id uuid, p_attempt integer, p_expiry_hours integer
) RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  job public.automation_trigger_jobs%ROWTYPE;
  pending public.automation_pending_executions%ROWTYPE;
  log_row public.automation_logs%ROWTYPE;
  step_row public.automation_steps%ROWTYPE;
  due_at timestamptz;
  expires_at timestamptz;
  detail text := 'missing_or_invalid_guest_phone';
BEGIN
  IF (p_trigger_job_id IS NULL) = (p_pending_id IS NULL)
    OR p_expiry_hours NOT BETWEEN 1 AND 720 THEN RETURN false;
  END IF;

  IF p_trigger_job_id IS NOT NULL THEN
    SELECT * INTO job FROM public.automation_trigger_jobs j
    WHERE j.id = p_trigger_job_id AND j.account_id = p_account_id
      AND j.automation_id = p_automation_id AND j.pms_reservation_id = p_reservation_id
      AND j.status = 'processing' AND j.attempt_count = p_attempt
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    due_at := job.run_at;
  ELSE
    SELECT * INTO pending FROM public.automation_pending_executions p
    WHERE p.id = p_pending_id AND p.account_id = p_account_id AND p.automation_id = p_automation_id
      AND p.log_id = p_log_id AND p.status = 'running' AND p.attempt_count = p_attempt
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    due_at := pending.run_at;
  END IF;

  SELECT * INTO log_row FROM public.automation_logs l
  WHERE l.id = p_log_id AND l.account_id = p_account_id AND l.automation_id = p_automation_id
  FOR UPDATE;
  IF NOT FOUND OR (p_trigger_job_id IS NOT NULL AND
    (log_row.trigger_job_id IS DISTINCT FROM p_trigger_job_id
     OR log_row.trigger_job_attempt_count IS DISTINCT FROM p_attempt
     OR log_row.trigger_job_execution_state <> 'processing')) THEN RETURN false; END IF;
  IF p_pending_id = ANY(log_row.completed_wait_continuation_ids) THEN RETURN false; END IF;
  -- Never clear evidence that the very action about to be parked may
  -- already have happened. Earlier successful actions remain on the log.
  IF log_row.retry_safety->>'step_id' = p_step_id::text
    OR pending.context #>> '{__retry_safety,step_id}' = p_step_id::text
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(log_row.steps_executed) step
      WHERE step->>'step_id' = p_step_id::text AND step->>'status' = 'success'
    )
  THEN RETURN false; END IF;

  -- Reservation identity comes from the originating job (including legacy
  -- Wait rows) and cannot be swapped by changing a saved context object.
  IF NOT EXISTS (
    SELECT 1 FROM public.automation_trigger_jobs j
    WHERE j.id = log_row.trigger_job_id AND j.pms_reservation_id = p_reservation_id
      AND j.account_id = p_account_id AND j.automation_id = p_automation_id
  ) THEN RETURN false; END IF;

  SELECT * INTO step_row FROM public.automation_steps s
    WHERE s.id = p_step_id AND s.automation_id = p_automation_id;
  IF NOT FOUND THEN RETURN false; END IF;

  expires_at := coalesce(pending.contact_recovery_expires_at,
    due_at + make_interval(hours => p_expiry_hours));
  IF p_pending_id IS NOT NULL AND pending.attempt_count >= 5 THEN
    detail := 'contact_recovery_attempts_exhausted';
  ELSIF expires_at <= now() THEN
    detail := 'contact_recovery_expired';
  END IF;

  IF p_pending_id IS NULL THEN
    INSERT INTO public.automation_pending_executions (
      account_id, automation_id, user_id, contact_id, log_id, context,
      parent_step_id, branch, next_step_position, run_at, status, next_attempt_at,
      last_error, blocked_step_id, blocked_step_type, pms_reservation_id, contact_recovery_expires_at
    ) VALUES (
      p_account_id, p_automation_id, log_row.user_id, log_row.contact_id, p_log_id,
      p_context - '__retry_safety', step_row.parent_step_id, step_row.branch, step_row.position,
      due_at, CASE WHEN detail = 'missing_or_invalid_guest_phone' THEN 'blocked_contact' ELSE 'failed' END,
      CASE WHEN detail = 'missing_or_invalid_guest_phone' THEN now() END,
      detail, p_step_id, step_row.step_type, p_reservation_id, expires_at
    );
    UPDATE public.automation_trigger_jobs SET
      status = 'completed', completed_at = now(), processing_started_at = NULL,
      next_attempt_at = NULL, retryable = false, last_error = NULL
    WHERE id = job.id AND account_id = p_account_id;
  ELSE
    UPDATE public.automation_pending_executions SET
      context = p_context - '__retry_safety', parent_step_id = step_row.parent_step_id,
      branch = step_row.branch, next_step_position = step_row.position, parked_step_id = NULL,
      blocked_step_id = p_step_id, blocked_step_type = step_row.step_type, pms_reservation_id = p_reservation_id,
      contact_recovery_expires_at = expires_at, processing_started_at = NULL,
      status = CASE WHEN detail = 'missing_or_invalid_guest_phone' THEN 'blocked_contact' ELSE 'failed' END,
      next_attempt_at = CASE WHEN detail = 'missing_or_invalid_guest_phone' THEN now() END,
      last_error = detail
    WHERE id = pending.id AND account_id = p_account_id;
  END IF;

  UPDATE public.automation_logs SET
    steps_executed = coalesce(steps_executed, '[]'::jsonb) || p_results,
    status = CASE WHEN detail = 'missing_or_invalid_guest_phone' THEN 'partial' ELSE 'failed' END,
    error_message = detail,
    trigger_job_execution_state = 'completed'
  WHERE id = p_log_id AND account_id = p_account_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.wake_pms_contact_continuations(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_pms_reservation_contact(uuid, uuid, uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.park_pms_contact_continuation(uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_pms_contact_continuations(uuid, uuid, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_pms_reservation_contact(uuid, uuid, uuid, text, text, jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.park_pms_contact_continuation(uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, uuid, uuid, integer, integer)
  TO service_role;

CREATE FUNCTION public.claim_automation_pending_with_contact_recovery(
  p_batch_size integer, p_now timestamptz, p_stale_before timestamptz, p_max_attempts integer
) RETURNS SETOF public.automation_pending_executions
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM public.wake_pms_contact_continuations(NULL, NULL, p_now);
  RETURN QUERY SELECT * FROM public.claim_automation_pending_executions(
    p_batch_size, p_now, p_stale_before, p_max_attempts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_automation_pending_with_contact_recovery(integer, timestamptz, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automation_pending_with_contact_recovery(integer, timestamptz, timestamptz, integer)
  TO service_role;

-- Different PMS revisions can repeat a confirmation with different event
-- IDs. Keep the first occurrence (including pre-migration occurrences).
CREATE INDEX automation_pms_confirmation_lookup
  ON public.automation_trigger_jobs (account_id, automation_id, pms_reservation_id)
  WHERE trigger_type = 'reservation_confirmed';

CREATE FUNCTION public.insert_pms_confirmation_job(p_job jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  job public.automation_trigger_jobs%ROWTYPE :=
    jsonb_populate_record(NULL::public.automation_trigger_jobs, p_job);
BEGIN
  IF job.trigger_type IS DISTINCT FROM 'reservation_confirmed' OR NOT EXISTS (
    SELECT 1 FROM public.pms_webhook_events e
    JOIN public.pms_reservations r ON r.id = job.pms_reservation_id
      AND r.account_id = e.account_id AND r.pms_integration_id = e.pms_integration_id
      AND r.external_reservation_id = e.external_resource_id
    WHERE e.id = job.pms_webhook_event_id AND e.account_id = job.account_id
      AND e.event_type = 'reservation.confirmed'
  ) THEN RAISE EXCEPTION 'Invalid PMS confirmation occurrence'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('pms-confirmation:%s:%s:%s', job.account_id, job.automation_id, job.pms_reservation_id), 0));
  IF EXISTS (SELECT 1 FROM public.automation_trigger_jobs j
    WHERE j.account_id = job.account_id AND j.automation_id = job.automation_id
      AND j.pms_reservation_id = job.pms_reservation_id AND j.trigger_type = job.trigger_type)
  THEN RETURN false; END IF;

  INSERT INTO public.automation_trigger_jobs (account_id, automation_id, pms_reservation_id,
    pms_webhook_event_id, trigger_type, occurrence_key, run_at, source_updated_at)
  VALUES (job.account_id, job.automation_id, job.pms_reservation_id, job.pms_webhook_event_id,
    job.trigger_type, job.occurrence_key, job.run_at, job.source_updated_at)
  ON CONFLICT (occurrence_key) DO NOTHING;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.insert_pms_confirmation_job(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_pms_confirmation_job(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_pms_automation_schedule_jobs(
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
  affected_keys TEXT[];
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

  WITH changed AS (
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
  WHERE public.automation_trigger_jobs.status NOT IN ('completed', 'processing')
    AND (public.automation_trigger_jobs.run_at IS DISTINCT FROM EXCLUDED.run_at
      OR public.automation_trigger_jobs.status = 'cancelled')
    AND public.automation_trigger_jobs.account_id = EXCLUDED.account_id
    AND public.automation_trigger_jobs.automation_id = EXCLUDED.automation_id
    AND public.automation_trigger_jobs.pms_reservation_id = EXCLUDED.pms_reservation_id
    AND public.automation_trigger_jobs.trigger_type = EXCLUDED.trigger_type
    AND public.automation_trigger_jobs.pms_webhook_event_id IS NULL
    AND (
      public.automation_trigger_jobs.source_updated_at IS NULL
      OR EXCLUDED.source_updated_at >= public.automation_trigger_jobs.source_updated_at
    )
  RETURNING occurrence_key
  )
  SELECT count(*), coalesce(array_agg(occurrence_key), '{}'::text[])
    INTO affected_count, affected_keys FROM changed;

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
    run_at TIMESTAMPTZ,
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
  WHERE NOT (job.occurrence_key = ANY(affected_keys))
    AND existing.status IS DISTINCT FROM 'completed'
    AND (
      reservation.updated_at > job.source_updated_at
      OR existing.source_updated_at > job.source_updated_at
      OR existing.status = 'processing'
      OR (existing.run_at = job.run_at AND existing.status <> 'cancelled')
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

COMMIT;
