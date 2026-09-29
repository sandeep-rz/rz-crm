import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/57_pms_automation_trigger_jobs.sql'),
  'utf8',
);

describe('PMS automation execution migration contract', () => {
  it('gives each PMS job one account-scoped automation log identity', () => {
    expect(migration).toContain(
      'CONSTRAINT automation_trigger_jobs_id_account_key UNIQUE (id, account_id)',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT automation_logs_trigger_job_unique UNIQUE (trigger_job_id)',
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(trigger_job_id, account_id\)[\s\S]*REFERENCES public\.automation_trigger_jobs\(id, account_id\)/,
    );
  });

  it('atomically gates completed, concurrent, and retry executions', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.begin_pms_automation_execution',
    );
    expect(migration).toMatch(
      /WHERE job\.id = p_job_id\s+FOR UPDATE;/,
    );
    expect(migration).toContain("claimed_job.status <> 'processing'");
    expect(migration).toContain('claimed_job.attempt_count <> p_attempt_count');
    expect(migration).toContain("'already_completed'::TEXT");
    expect(migration).toContain("'already_running'::TEXT");
    expect(migration).toContain("'started'::TEXT");
    expect(migration).toMatch(
      /IF existing_log\.trigger_job_execution_state = 'completed' THEN/,
    );
  });

  it('restricts the security-definer gate to the service role', () => {
    expect(migration).toMatch(
      /begin_pms_automation_execution[\s\S]*SECURITY DEFINER\s+SET search_path = ''/,
    );
    expect(migration).toMatch(
      /REVOKE ALL[\s\S]*begin_pms_automation_execution\(UUID, INTEGER, UUID\)[\s\S]*FROM PUBLIC, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*begin_pms_automation_execution\(UUID, INTEGER, UUID\)[\s\S]*TO service_role;/,
    );
  });
});
