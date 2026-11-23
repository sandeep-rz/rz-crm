import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { checkRunTimeout } from './timeout';
import { MAX_FLOW_TIMEOUT_HOURS } from './types';

const NOW = new Date('2026-10-16T12:00:00Z');

describe('checkRunTimeout', () => {
  it('uses the default 24h policy when the flow has none', () => {
    expect(checkRunTimeout('2026-10-15T12:00:01Z', null, NOW).timedOut).toBe(
      false
    );
    expect(checkRunTimeout('2026-10-15T12:00:00Z', null, NOW)).toEqual({
      timedOut: true,
      ageHours: 24,
      policyHours: 24,
    });
  });

  it("honours the flow's on_timeout_hours", () => {
    const policy = { on_timeout_hours: 2 };
    expect(checkRunTimeout('2026-10-16T10:30:00Z', policy, NOW).timedOut).toBe(
      false
    );
    expect(checkRunTimeout('2026-10-16T09:59:00Z', policy, NOW).timedOut).toBe(
      true
    );
  });

  it('caps on_timeout_hours at the same ceiling as the database sweep', () => {
    const check = checkRunTimeout(
      '2016-10-16T12:00:00Z',
      { on_timeout_hours: 99999999 },
      NOW
    );
    expect(check.policyHours).toBe(MAX_FLOW_TIMEOUT_HOURS);
    expect(check.timedOut).toBe(true);
  });

  it('never times out a run with an unparseable timestamp', () => {
    expect(checkRunTimeout('not a date', null, NOW).timedOut).toBe(false);
  });
});

it('does not expire a run advanced since the sweep snapshot', async () => {
  const { createFakeDb } = await import('./fake-db.test-helper');
  const { markRunTimedOut } = await import('./timeout');
  const tables = {
    flow_runs: [
      { id: 'run', status: 'active', last_advanced_at: '2026-11-23T11:00:00Z' },
    ],
    flow_run_events: [],
  };
  const db = createFakeDb(tables);
  expect(
    await markRunTimedOut(
      db as unknown as SupabaseClient,
      'run',
      { timedOut: true, ageHours: 25, policyHours: 24 },
      'sweep',
      new Date('2026-11-23T12:00:00Z'),
      '2026-11-22T10:00:00Z'
    )
  ).toBe(false);
  expect(tables.flow_runs[0].status).toBe('active');
  expect(tables.flow_run_events).toHaveLength(0);
});
