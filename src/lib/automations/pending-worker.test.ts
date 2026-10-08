import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  PENDING_LEASE_MS,
  PENDING_MAX_ATTEMPTS,
  pendingRetryDelayMs,
  runPendingExecutionWorker,
  type PendingExecutionRow,
} from './pending-worker';

function row(id: string, attemptCount = 1): PendingExecutionRow {
  return {
    id,
    automation_id: `automation-${id}`,
    account_id: 'account-1',
    user_id: 'user-1',
    contact_id: 'contact-1',
    log_id: 'log-1',
    parent_step_id: null,
    branch: null,
    next_step_position: 2,
    context: { vars: { source: 'preserved' } },
    attempt_count: attemptCount,
  };
}

function fakeDb(
  rows: PendingExecutionRow[],
  safety: Record<string, unknown> = {
    context: {},
    retry_safety: null,
    completed_wait_continuation_ids: [],
  }
) {
  const rpc = vi.fn(async () => ({ data: rows, error: null }));
  const updates: { payload: Record<string, unknown>; filters: unknown[][] }[] =
    [];
  return {
    db: {
      rpc,
      from: () => {
        const operation = {
          payload: {} as Record<string, unknown>,
          filters: [] as unknown[][],
        };
        const builder = {
          select: () => builder,
          single: async () => ({ data: safety, error: null }),
          update(payload: Record<string, unknown>) {
            operation.payload = payload;
            return builder;
          },
          eq(column: string, value: unknown) {
            operation.filters.push([column, value]);
            return builder;
          },
          then(resolve: (value: { error: null }) => unknown) {
            updates.push(operation);
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return builder;
      },
    } as unknown as SupabaseClient,
    rpc,
    updates,
  };
}

describe('runPendingExecutionWorker', () => {
  it('claims a bounded batch with a stale cutoff and preserves context on resume', async () => {
    const now = new Date('2026-09-30T08:00:00.000Z');
    const harness = fakeDb([row('one')]);
    const resume = vi.fn(async () => undefined);

    await expect(
      runPendingExecutionWorker({ db: harness.db, now, resume })
    ).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
    expect(harness.rpc).toHaveBeenCalledWith(
      'claim_automation_pending_executions',
      {
        p_batch_size: 50,
        p_now: now.toISOString(),
        p_stale_before: new Date(
          now.getTime() - PENDING_LEASE_MS
        ).toISOString(),
        p_max_attempts: PENDING_MAX_ATTEMPTS,
      }
    );
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'one',
        context: { vars: { source: 'preserved' } },
      })
    );
  });

  it('records retry state and continues processing the rest of the claimed batch', async () => {
    const now = new Date('2026-09-30T08:00:00.000Z');
    const harness = fakeDb([row('bad', 2), row('good', 1)]);
    const resume = vi.fn(async (pending: { id: string }) => {
      if (pending.id === 'bad') throw new Error('temporary database failure');
    });

    const result = await runPendingExecutionWorker({
      db: harness.db,
      now,
      resume,
    });

    expect(result).toEqual({ claimed: 2, completed: 1, retried: 1, failed: 0 });
    expect(resume).toHaveBeenCalledTimes(2);
    expect(harness.updates[0]).toEqual({
      payload: {
        status: 'pending',
        processing_started_at: null,
        next_attempt_at: new Date(
          now.getTime() + pendingRetryDelayMs(2)
        ).toISOString(),
        last_error: 'temporary database failure',
      },
      filters: [
        ['id', 'bad'],
        ['status', 'running'],
        ['attempt_count', 2],
      ],
    });
  });

  it('marks the final failed attempt terminal instead of retrying forever', async () => {
    const harness = fakeDb([row('terminal', PENDING_MAX_ATTEMPTS)]);
    const result = await runPendingExecutionWorker({
      db: harness.db,
      now: new Date('2026-09-30T08:00:00.000Z'),
      resume: async () => {
        throw new Error('still broken');
      },
    });

    expect(result).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
    expect(harness.updates[0].payload).toMatchObject({
      status: 'failed',
      next_attempt_at: null,
      last_error: 'still broken',
    });
  });

  it('uses bounded exponential backoff', () => {
    expect(pendingRetryDelayMs(1)).toBe(60_000);
    expect(pendingRetryDelayMs(2)).toBe(120_000);
    expect(pendingRetryDelayMs(3)).toBe(240_000);
    expect(pendingRetryDelayMs(99)).toBe(3_600_000);
  });
});

it('does not schedule a continuation retry after uncertain external action evidence', async () => {
  const harness = fakeDb([row('bad')], {
    context: {
      __retry_safety: { reason: 'whatsapp_unknown', step_id: 'inside' },
    },
    retry_safety: { reason: 'whatsapp_unknown' },
    completed_wait_continuation_ids: [],
  });
  expect(
    await runPendingExecutionWorker({
      db: harness.db,
      resume: async () => {
        throw new Error('post-send crash');
      },
    })
  ).toMatchObject({ failed: 1, retried: 0 });
  expect(harness.updates[0].payload).toMatchObject({
    status: 'failed',
    next_attempt_at: null,
  });
});
it('still retries completion bookkeeping when the continuation already has its completion marker', async () => {
  const harness = fakeDb([row('done')], {
    retry_safety: { reason: 'whatsapp_accepted' },
    completed_wait_continuation_ids: ['done'],
  });
  expect(
    await runPendingExecutionWorker({
      db: harness.db,
      resume: async () => {
        throw new Error('mark done failed');
      },
    })
  ).toMatchObject({ failed: 0, retried: 1 });
});

it('retries a harmless continuation despite a pre-Wait execution guard', async () => {
  const harness = fakeDb([row('safe', 2)], {
    retry_safety: { reason: 'whatsapp_accepted', step_id: 'before-wait' },
    completed_wait_continuation_ids: [],
    context: {},
  });
  expect(
    await runPendingExecutionWorker({
      db: harness.db,
      resume: async () => {
        throw new Error('safe continuation lookup failed');
      },
    })
  ).toMatchObject({ failed: 0, retried: 1 });
  expect(harness.updates[0].payload.status).toBe('pending');
});
