import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const initialMigration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260929175559_batch_upsert_pms_automation_schedules.sql'
  ),
  'utf8'
);
const hardeningMigration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260929180941_harden_pms_schedule_backfill_lifecycle.sql'
  ),
  'utf8'
);

describe('PMS schedule batch-upsert migration', () => {
  it('reuses occurrence uniqueness and never reopens completed executions', () => {
    expect(initialMigration).toContain(
      'ON CONFLICT (occurrence_key) DO UPDATE'
    );
    expect(hardeningMigration).toContain(
      'ON CONFLICT (occurrence_key) DO UPDATE'
    );
    expect(hardeningMigration).toContain(
      "public.automation_trigger_jobs.status <> 'completed'"
    );
    expect(hardeningMigration).toContain(
      'public.automation_trigger_jobs.account_id = EXCLUDED.account_id'
    );
  });

  it('is callable only by the service role', () => {
    expect(hardeningMigration).toMatch(
      /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated;/
    );
    expect(hardeningMigration).toMatch(/GRANT EXECUTE[\s\S]*TO service_role;/);
  });

  it('rejects identity collisions and requires complete result accounting', () => {
    expect(hardeningMigration).toContain(
      'PMS schedule occurrence key identity collision.'
    );
    expect(hardeningMigration).toContain(
      'affected_count + completed_count + stale_count <> requested_count'
    );
  });

  it('preserves newer reservation schedules and gates execution on active state', () => {
    expect(hardeningMigration).toContain('source_updated_at');
    expect(hardeningMigration).toContain(
      'reservation.updated_at <= job.source_updated_at'
    );
    expect(hardeningMigration).toContain(
      'reservation.updated_at > job.source_updated_at'
    );
    expect(hardeningMigration).toContain(
      'EXCLUDED.source_updated_at >= public.automation_trigger_jobs.source_updated_at'
    );
    expect(hardeningMigration).toContain('IF NOT job_automation.is_active');
    expect(hardeningMigration).toContain("'ineligible'::TEXT");
  });
});
