import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260930073200_harden_automation_continuations_and_round_robin.sql'
  ),
  'utf8'
);

describe('automation hardening migration', () => {
  it('atomically claims only due or stale continuations with SKIP LOCKED', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_automation_pending_executions/
    );
    expect(sql).toMatch(
      /status = 'pending'[\s\S]*COALESCE\(candidate\.next_attempt_at, candidate\.run_at\) <= p_now/
    );
    expect(sql).toMatch(
      /status = 'running'[\s\S]*processing_started_at < p_stale_before/
    );
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/LIMIT p_batch_size/);
    expect(sql).toMatch(/attempt_count = pending\.attempt_count \+ 1/);
  });

  it('keeps future and recent running continuations ineligible', () => {
    expect(sql).toContain(
      'COALESCE(candidate.next_attempt_at, candidate.run_at) <= p_now'
    );
    expect(sql).toContain('candidate.processing_started_at < p_stale_before');
  });

  it('makes the claim RPC service-role only with a fixed search path', () => {
    expect(sql).toMatch(
      /claim_automation_pending_executions[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = ''/
    );
    expect(sql).toMatch(
      /REVOKE ALL[\s\S]*claim_automation_pending_executions[\s\S]*FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE[\s\S]*claim_automation_pending_executions[\s\S]*TO service_role;/
    );
  });

  it('serializes independent per-workspace round-robin cursors', () => {
    expect(sql).toContain('account_id UUID PRIMARY KEY');
    expect(sql).toMatch(
      /automation_round_robin_state[\s\S]*WHERE state\.account_id = p_account_id[\s\S]*FOR UPDATE;/
    );
    expect(sql).toMatch(
      /FROM public\.account_members AS member[\s\S]*member\.account_id = p_account_id/
    );
    expect(sql).toMatch(/member\.user_id > v_last/);
    expect(sql).toMatch(
      /claim_automation_round_robin_assignee[\s\S]*FROM PUBLIC, anon, authenticated;/
    );
  });
});
