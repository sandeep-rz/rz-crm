-- Run with psql -v ON_ERROR_STOP=1 against a disposable CRM database with
-- the production migrations applied. No worker endpoints or Meta calls.
BEGIN;

DO $$
DECLARE
  owner_id uuid := gen_random_uuid();
  account_id_value uuid := gen_random_uuid();
  foreign_account uuid := gen_random_uuid();
  integration_a uuid := gen_random_uuid();
  integration_b uuid := gen_random_uuid();
  property_a uuid := gen_random_uuid();
  property_b uuid := gen_random_uuid();
  auto_id uuid := gen_random_uuid();
  step_id uuid := gen_random_uuid();
  log_id_value uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  reservation_id_value uuid;
  contact_id_value uuid;
  result jsonb;
  pending public.automation_pending_executions%ROWTYPE;
  event_id uuid;
  schedule_job jsonb;
  snapshot jsonb := jsonb_build_object(
    'external_reservation_id', 'fixture-booking', 'status', 'confirmed',
    'provider_status', 'confirmed', 'external_created_at', '2026-01-01T00:00:00Z',
    'external_updated_at', '2026-01-01T01:00:00Z', 'metadata', '{}'::jsonb
  );
  scheduled_id uuid := gen_random_uuid();
  due_at timestamptz := now() - interval '2 hours';
BEGIN
  ASSERT NOT has_function_privilege('authenticated',
    'public.sync_pms_reservation_contact(uuid,uuid,uuid,text,text,jsonb,jsonb)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated',
    'public.wake_pms_contact_continuations(uuid,uuid,timestamptz)', 'EXECUTE');

  INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES (owner_id, 'pms-fixture@example.test', '{}'::jsonb);
  INSERT INTO public.accounts (id, name, owner_user_id) VALUES
    (account_id_value, 'PMS fixture', owner_id), (foreign_account, 'Foreign fixture', owner_id);
  INSERT INTO public.pms_integrations (id, account_id, provider, external_account_id, status) VALUES
    (integration_a, account_id_value, 'rukiye_zara', 'fixture', 'connected'),
    (integration_b, account_id_value, 'another_pms', 'fixture', 'connected');
  INSERT INTO public.pms_properties
    (id, account_id, pms_integration_id, external_property_id, initial_sync_status) VALUES
    (property_a, account_id_value, integration_a, 'fixture-property', 'completed'),
    (property_b, account_id_value, integration_b, 'fixture-property', 'completed');

  result := public.sync_pms_reservation_contact(account_id_value, integration_a, property_a,
    'fixture-property', 'rukiye_zara', '{}', snapshot);
  reservation_id_value := (result->>'reservationId')::uuid;
  ASSERT result->>'contactId' IS NULL;

  INSERT INTO public.automations (id, account_id, user_id, name, trigger_type, is_active)
    VALUES (auto_id, account_id_value, owner_id, 'fixture', 'before_checkin', true);
  INSERT INTO public.automation_steps (id, automation_id, step_type, position)
    VALUES (step_id, auto_id, 'send_template', 2);
  INSERT INTO public.automation_trigger_jobs (id, account_id, automation_id,
    pms_reservation_id, trigger_type, occurrence_key, run_at, status, attempt_count)
    VALUES (job_id, account_id_value, auto_id, reservation_id_value, 'before_checkin',
      'fixture-due', due_at, 'processing', 1);
  INSERT INTO public.automation_logs (id, account_id, automation_id, user_id,
    trigger_event, status, trigger_job_id, trigger_job_attempt_count, trigger_job_execution_state,
    retry_safety)
    VALUES (log_id_value, account_id_value, auto_id, owner_id,
      'before_checkin', 'failed', job_id, 1, 'processing',
      '{"reason":"whatsapp_accepted","step_id":"earlier","provider_message_id":"wamid.fixture"}');

  -- Even a malformed checkpoint request cannot reopen an ambiguous send.
  UPDATE public.automation_logs SET retry_safety =
    jsonb_build_object('reason','whatsapp_unknown','step_id',step_id)
    WHERE id = log_id_value;
  ASSERT NOT public.park_pms_contact_continuation(account_id_value, auto_id, log_id_value,
    reservation_id_value, step_id, '{}', '[]', job_id, NULL, 1, 24);
  UPDATE public.automation_logs SET retry_safety =
    '{"reason":"whatsapp_accepted","step_id":"earlier","provider_message_id":"wamid.fixture"}'
    WHERE id = log_id_value;

  ASSERT NOT public.park_pms_contact_continuation(foreign_account, auto_id, log_id_value,
    reservation_id_value, step_id, '{}', '[]', job_id, NULL, 1, 24);
  ASSERT public.park_pms_contact_continuation(account_id_value, auto_id, log_id_value,
    reservation_id_value, step_id, '{}', '[{"step_id":"earlier","status":"success"}]', job_id, NULL, 1, 24);
  ASSERT NOT public.park_pms_contact_continuation(account_id_value, auto_id, log_id_value,
    reservation_id_value, step_id, '{}', '[]', job_id, NULL, 1, 24);
  SELECT * INTO STRICT pending FROM public.automation_pending_executions WHERE log_id = log_id_value;
  ASSERT pending.status = 'blocked_contact' AND pending.run_at = due_at
    AND pending.blocked_step_id = step_id AND pending.next_step_position = 2;
  ASSERT (SELECT status = 'completed' AND attempt_count = 1 FROM public.automation_trigger_jobs WHERE id = job_id);
  ASSERT (SELECT retry_safety->>'reason' = 'whatsapp_accepted' FROM public.automation_logs WHERE id = log_id_value);

  result := public.sync_pms_reservation_contact(account_id_value, integration_a, property_a,
    'fixture-property', 'rukiye_zara', '{"phone":"+14155550123","email":"test@example.test","name":"Guest"}',
    snapshot || '{"external_updated_at":"2026-01-01T02:00:00Z","external_created_at":null}');
  contact_id_value := (result->>'contactId')::uuid;
  ASSERT result->>'reservationId' = reservation_id_value::text AND contact_id_value IS NOT NULL;
  ASSERT (SELECT external_created_at = '2026-01-01T00:00:00Z' FROM public.pms_reservations WHERE id = reservation_id_value);
  ASSERT (SELECT status = 'pending' AND run_at = due_at FROM public.automation_pending_executions WHERE id = pending.id);

  -- No second claim for a repeated worker request. The wait row retains its
  -- identity and attempt history if the same segment needs another block.
  ASSERT (SELECT count(*) = 1 FROM public.claim_automation_pending_with_contact_recovery(10, now(), now() - interval '15 minutes', 5));
  ASSERT (SELECT count(*) = 0 FROM public.claim_automation_pending_with_contact_recovery(10, now(), now() - interval '15 minutes', 5));

  result := public.sync_pms_reservation_contact(account_id_value, integration_a, property_a,
    'fixture-property', 'rukiye_zara', '{"phone":"+442079460958","name":"Stale"}', snapshot);
  ASSERT (result->>'skippedStale')::boolean;
  ASSERT (SELECT phone = '+14155550123' AND name = 'Guest' FROM public.contacts WHERE id = contact_id_value);

  result := public.sync_pms_reservation_contact(account_id_value, integration_a, property_a,
    'fixture-property', 'rukiye_zara', '{}', snapshot || '{"external_updated_at":"2026-01-01T03:00:00Z"}');
  ASSERT result->>'contactId' = contact_id_value::text;
  ASSERT (SELECT phone = '+14155550123' AND email = 'test@example.test' FROM public.contacts WHERE id = contact_id_value);
  result := public.sync_pms_reservation_contact(account_id_value, integration_a, property_a,
    'fixture-property', 'rukiye_zara', '{"phone":"+442079460958","email":null}',
    snapshot || '{"external_updated_at":"2026-01-01T04:00:00Z"}');
  ASSERT result->>'contactId' = contact_id_value::text;
  ASSERT (SELECT phone = '+442079460958' AND email IS NULL FROM public.contacts WHERE id = contact_id_value);

  result := public.sync_pms_reservation_contact(account_id_value, integration_b, property_b,
    'fixture-property', 'another_pms', '{"phone":"+442079460958"}', snapshot);
  ASSERT result->>'reservationId' <> reservation_id_value::text AND result->>'contactId' = contact_id_value::text;

  BEGIN
    PERFORM public.sync_pms_reservation_contact(foreign_account, integration_a, property_a,
      'fixture-property', 'rukiye_zara', '{}', snapshot);
    RAISE EXCEPTION 'Cross-account reservation mutation accepted' USING ERRCODE = 'XX000';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;

  -- A phone added before a time-based occurrence is due never makes it
  -- run early. The same job can be claimed when its original due time arrives.
  INSERT INTO public.automation_trigger_jobs (id, account_id, automation_id,
    pms_reservation_id, trigger_type, occurrence_key, run_at)
    VALUES (scheduled_id, account_id_value, auto_id, reservation_id_value, 'checkin_day',
      format('pms:schedule:%s:%s:checkin_day', auto_id, reservation_id_value), now() + interval '1 hour');
  UPDATE public.automation_trigger_jobs SET last_error = 'prior attempt', attempt_count = 1
    WHERE id = scheduled_id;
  schedule_job := (SELECT jsonb_build_object(
    'account_id', account_id_value, 'automation_id', auto_id, 'pms_reservation_id', reservation_id_value,
    'trigger_type', 'checkin_day', 'occurrence_key', format('pms:schedule:%s:%s:checkin_day', auto_id, reservation_id_value),
    'run_at', now() + interval '1 hour', 'source_updated_at', r.updated_at)
    FROM public.pms_reservations r WHERE r.id = reservation_id_value);
  ASSERT (public.upsert_pms_automation_schedule_jobs(jsonb_build_array(schedule_job))->>'affected')::int = 0;
  ASSERT (SELECT last_error = 'prior attempt' AND attempt_count = 1 FROM public.automation_trigger_jobs WHERE id = scheduled_id);
  ASSERT NOT EXISTS (SELECT 1 FROM public.claim_automation_trigger_jobs(10, now() - interval '15 minutes', now()) claimed
    WHERE claimed.job_id = scheduled_id);
  ASSERT EXISTS (SELECT 1 FROM public.claim_automation_trigger_jobs(10, now() - interval '15 minutes', now() + interval '1 hour') claimed
    WHERE claimed.job_id = scheduled_id AND claimed.run_at = now() + interval '1 hour');

  -- A parked wait keeps its own original due time, including when overdue.
  ASSERT public.park_pms_contact_continuation(account_id_value, auto_id, log_id_value,
    reservation_id_value, step_id, '{}', '[]', NULL, pending.id, 1, 24);
  ASSERT (SELECT status = 'blocked_contact' AND attempt_count = 1 AND run_at = due_at
    FROM public.automation_pending_executions WHERE id = pending.id);

  -- Periodic reconciliation can recover after a direct contact correction.
  PERFORM public.wake_pms_contact_continuations(foreign_account, reservation_id_value, now());
  ASSERT (SELECT status = 'blocked_contact' FROM public.automation_pending_executions WHERE id = pending.id);
  ASSERT (SELECT count(*) = 1 FROM public.claim_automation_pending_with_contact_recovery(10, now(), now() - interval '15 minutes', 5));
  ASSERT public.park_pms_contact_continuation(account_id_value, auto_id, log_id_value,
    reservation_id_value, step_id, '{}', '[]', NULL, pending.id, 2, 24);

  UPDATE public.automations SET is_active = false WHERE id = auto_id;
  PERFORM public.wake_pms_contact_continuations(account_id_value, reservation_id_value, now());
  ASSERT (SELECT status = 'failed' AND last_error = 'automation_inactive'
    FROM public.automation_pending_executions WHERE id = pending.id);

  UPDATE public.automations SET is_active = true, trigger_type = 'reservation_confirmed' WHERE id = auto_id;
  UPDATE public.automation_pending_executions SET status = 'blocked_contact', next_attempt_at = now()
    WHERE id = pending.id;
  UPDATE public.pms_reservations SET status = 'cancelled' WHERE id = reservation_id_value;
  PERFORM public.wake_pms_contact_continuations(account_id_value, reservation_id_value, now());
  ASSERT (SELECT status = 'failed' AND last_error = 'reservation_cancelled'
    FROM public.automation_pending_executions WHERE id = pending.id);

  UPDATE public.automation_pending_executions
    SET status = 'blocked_contact', next_attempt_at = now(), contact_recovery_expires_at = now() - interval '1 minute'
    WHERE id = pending.id;
  UPDATE public.pms_reservations SET status = 'confirmed' WHERE id = reservation_id_value;
  PERFORM public.wake_pms_contact_continuations(account_id_value, reservation_id_value, now());
  ASSERT (SELECT status = 'failed' AND last_error = 'contact_recovery_expired'
    FROM public.automation_pending_executions WHERE id = pending.id);

  FOR n IN 1..2 LOOP
    INSERT INTO public.pms_webhook_events (provider, external_event_id, account_id,
      pms_integration_id, pms_property_id, event_type, external_resource_id, status)
    VALUES ('rukiye_zara', 'fixture-event-' || n, account_id_value, integration_a, property_a,
      'reservation.confirmed', 'fixture-booking', 'processed') RETURNING id INTO event_id;
    ASSERT public.insert_pms_confirmation_job(jsonb_build_object(
      'account_id', account_id_value, 'automation_id', auto_id, 'pms_reservation_id', reservation_id_value,
      'pms_webhook_event_id', event_id, 'trigger_type', 'reservation_confirmed',
      'occurrence_key', 'fixture-event-' || n, 'run_at', now()
    )) = (n = 1);
  END LOOP;
END;
$$;

ROLLBACK;
