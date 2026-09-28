import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/55_pms_webhook_event_processing.sql'
  ),
  'utf8'
);

describe('PMS webhook worker migration', () => {
  it('keeps immediate wake-up failure outside the durable receipt outcome', () => {
    expect(migration).toContain(
      'CREATE TRIGGER pms_webhook_event_worker_wakeup'
    );
    expect(migration).toMatch(
      /wake_pms_webhook_event_worker_on_insert\(\)[\s\S]*EXCEPTION[\s\S]*WHEN OTHERS THEN[\s\S]*RETURN NEW;/
    );
    expect(migration).toMatch(
      /wake_pms_webhook_event_worker\(\)[\s\S]*EXCEPTION[\s\S]*WHEN OTHERS THEN[\s\S]*RETURN NULL;/
    );
  });

  it('uses an atomic skip-locked claim and a one-minute recovery job', () => {
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain("'pms-webhook-event-worker'");
    expect(migration).toContain("'* * * * *'");
    expect(migration).toContain("WHERE name = 'pms_sync_worker_token'");
    expect(migration).not.toMatch(/RZ_PMS_API_SECRET\s*=/);
  });
});
