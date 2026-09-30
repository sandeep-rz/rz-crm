import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260930083715_protect_wait_continuation_replay.sql'
  ),
  'utf8'
);

describe('Wait continuation replay migration', () => {
  it('stores stable pending-execution identities on the existing automation log', () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.automation_logs[\s\S]*completed_wait_continuation_ids UUID\[\]/
    );
    expect(sql).toContain("NOT NULL DEFAULT '{}'::UUID[]");
    expect(sql).toMatch(
      /array_append\([\s\S]*completed_wait_continuation_ids[\s\S]*p_pending_execution_id/
    );
  });

  it('validates the log, workspace, and automation relationship atomically', () => {
    expect(sql).toContain('log.id = p_log_id');
    expect(sql).toContain('log.account_id = p_account_id');
    expect(sql).toContain('log.automation_id = p_automation_id');
    expect(sql).toMatch(
      /NOT \(p_pending_execution_id = ANY\(log\.completed_wait_continuation_ids\)\)/
    );
  });

  it('makes the completion RPC idempotent and service-role only', () => {
    expect(sql).toMatch(
      /complete_automation_wait_continuation[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = ''/
    );
    expect(sql).toMatch(
      /REVOKE ALL[\s\S]*complete_automation_wait_continuation[\s\S]*FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE[\s\S]*complete_automation_wait_continuation[\s\S]*TO service_role;/
    );
    expect(sql).toMatch(
      /RETURN EXISTS \([\s\S]*ANY\(log\.completed_wait_continuation_ids\)/
    );
  });
});
