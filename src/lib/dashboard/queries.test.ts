import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadConversationsSeries, loadResponseTime } from './queries';

const SERVER_ROW_CAP = 1000;

function cappedDb(rows: Record<string, unknown>[]) {
  const ranges: [number, number][] = [];
  const chain = {
    select: () => chain,
    gte: () => chain,
    order: () => chain,
    range: async (from: number, to: number) => {
      ranges.push([from, to]);
      const end = Math.min(to + 1, from + SERVER_ROW_CAP);
      return { data: rows.slice(from, end), error: null };
    },
  };
  const db = { from: () => chain } as unknown as SupabaseClient;
  return { db, ranges };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadConversationsSeries', () => {
  it('counts every message past the 1000-row response cap', async () => {
    const at = new Date(2026, 4, 18, 9, 0, 0).toISOString();
    const rows = Array.from({ length: 2600 }, (_, i) => ({
      created_at: at,
      sender_type: i % 2 === 0 ? 'customer' : 'agent',
    }));
    const { db, ranges } = cappedDb(rows);
    const series = await loadConversationsSeries(db, 1);
    expect(series).toEqual([
      { day: '2026-05-18', incoming: 1300, outgoing: 1300 },
    ]);
    expect(ranges.length).toBeGreaterThanOrEqual(3);
  });
});

describe('loadResponseTime', () => {
  const series = {
    buckets: Array.from({ length: 7 }, (_, dow) => ({
      dow,
      avgMinutes: null,
      samples: 0,
    })),
    thisWeekAvg: null,
    lastWeekAvg: null,
  };
  it('requests only the selected workspace and retains separate series', async () => {
    const data = {
      timeZone: 'Asia/Kolkata',
      human: series,
      ai: { ...series, thisWeekAvg: 1 },
    };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    expect(
      await loadResponseTime({ rpc } as unknown as SupabaseClient, 'workspace')
    ).toEqual(data);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('dashboard_response_metrics', {
      p_account: 'workspace',
    });
  });
  it('surfaces a denied or failed query rather than manufacturing zeroes', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(
      loadResponseTime({ rpc } as unknown as SupabaseClient, 'foreign')
    ).rejects.toThrow('Could not load');
  });
  it.each([
    null,
    {},
    { timeZone: 'UTC', human: series, ai: { ...series, thisWeekAvg: -1 } },
  ])('rejects an incomplete or invalid response: %j', async (data) => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    await expect(
      loadResponseTime({ rpc } as unknown as SupabaseClient, 'workspace')
    ).rejects.toThrow('Invalid');
  });
});
