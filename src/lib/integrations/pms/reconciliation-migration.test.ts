import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/56_pms_reservation_reconciliation.sql'
  ),
  'utf8'
);

describe('PMS reconciliation migration', () => {
  it('atomically claims only active properties on connected integrations', () => {
    expect(migration).toContain('FOR UPDATE OF property SKIP LOCKED');
    expect(migration).toContain("property.status = 'active'");
    expect(migration).toContain("integration.status = 'connected'");
    expect(migration).toContain(
      'reconciliation_attempt_count = property.reconciliation_attempt_count + 1'
    );
  });

  it('uses the shared token and a separate URL Vault entry', () => {
    expect(migration).toContain("WHERE name = 'pms_sync_worker_token'");
    expect(migration).toContain("WHERE name = 'pms_reconciliation_worker_url'");
    expect(migration).not.toMatch(/PMS_SYNC_WORKER_TOKEN\s*=/);
  });

  it('idempotently schedules the application wake-up every six hours', () => {
    expect(migration).toContain("'pms-reservation-reconciliation'");
    expect(migration).toContain("'0 */6 * * *'");
    expect(migration).toContain('cron.unschedule(existing_job_id)');
    expect(migration).toContain(
      'SELECT public.wake_pms_reconciliation_worker();'
    );
    expect(migration).not.toMatch(/UPDATE\s+cron\.job/i);
  });

  it('does not perform PMS HTTP or reservation projection inside Postgres', () => {
    expect(migration).not.toMatch(/RZ_PMS_API_(BASE_URL|KEY_ID|SECRET)/);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.pms_reservations/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.contacts/i);
  });
});
