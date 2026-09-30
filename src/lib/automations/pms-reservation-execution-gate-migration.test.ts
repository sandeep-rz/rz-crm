import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260929182912_add_pms_reservation_execution_version_gate.sql'
  ),
  'utf8'
);

describe('PMS reservation-version execution gate migration', () => {
  it('adds a rolling-deployment-compatible four-argument overload', () => {
    expect(migration).toContain(
      'p_expected_reservation_updated_at TIMESTAMPTZ'
    );
    expect(migration).not.toContain(
      'DROP FUNCTION public.begin_pms_automation_execution'
    );
    expect(migration).toContain(
      'begin_pms_automation_execution(UUID, INTEGER, UUID, TIMESTAMPTZ)'
    );
  });

  it('locks and validates only the claimed canonical reservation', () => {
    expect(migration).toContain(
      'reservation.id = claimed_job.pms_reservation_id'
    );
    expect(migration).toContain(
      'reservation.account_id = claimed_job.account_id'
    );
    expect(migration).toContain('FOR SHARE');
    expect(migration).toContain(
      'job_reservation.updated_at IS DISTINCT FROM p_expected_reservation_updated_at'
    );
    expect(migration).toContain("'reservation_changed'::TEXT");
  });

  it('preserves active-state and durable replay gates', () => {
    expect(migration).toContain('IF NOT job_automation.is_active');
    expect(migration).toContain(
      'job_automation.trigger_type <> claimed_job.trigger_type'
    );
    expect(migration).toContain("'ineligible'::TEXT");
    expect(migration).toContain("'already_completed'::TEXT");
    expect(migration).toContain("'already_running'::TEXT");

    const completedPosition = migration.indexOf("'already_completed'::TEXT");
    const reservationCheckPosition = migration.indexOf(
      'job_reservation.updated_at IS DISTINCT FROM'
    );
    expect(completedPosition).toBeGreaterThan(-1);
    expect(completedPosition).toBeLessThan(reservationCheckPosition);
  });

  it('remains service-role-only with a fixed search path', () => {
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
    expect(migration).toMatch(
      /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated;/
    );
    expect(migration).toMatch(/GRANT EXECUTE[\s\S]*TO service_role;/);
  });
});
