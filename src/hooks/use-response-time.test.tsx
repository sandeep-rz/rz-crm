// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useResponseTime } from './use-response-time';
import type { ResponseTimeSummary } from '@/lib/dashboard/types';
const h = vi.hoisted(() => ({
  accountId: 'a',
  accountStatus: 'ready',
  defaultTimezone: 'UTC',
  load: vi.fn(),
}));
vi.mock('./use-auth', () => ({ useAuth: () => h }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/dashboard/queries', () => ({ loadResponseTime: h.load }));
const empty = {
  buckets: Array.from({ length: 7 }, (_, dow) => ({
    dow,
    avgMinutes: null,
    samples: 0,
  })),
  thisWeekAvg: null,
  lastWeekAvg: null,
};
const summary = (minutes: number): ResponseTimeSummary => ({
  timeZone: 'UTC',
  human: { ...empty, thisWeekAvg: minutes },
  ai: empty,
});
const pending = () => {
  let resolve!: (v: ResponseTimeSummary) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<ResponseTimeSummary>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let host: HTMLDivElement, root: Root, hook: ReturnType<typeof useResponseTime>;
function Harness() {
  const api = useResponseTime();
  useEffect(() => {
    hook = api;
  }, [api]);
  return (
    <span>
      {api.data?.human.thisWeekAvg ?? (api.error ? 'error' : 'loading')}
    </span>
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.accountId = 'a';
  h.accountStatus = 'ready';
  h.defaultTimezone = 'UTC';
  h.load.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () => {
    root.render(<Harness />);
  });
it('clears prior workspace results immediately and ignores a late response', async () => {
  const first = pending(),
    second = pending();
  h.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render();
  h.accountId = 'b';
  await render();
  expect(host.textContent).toBe('loading');
  await act(async () => second.resolve(summary(8)));
  expect(host.textContent).toBe('8');
  await act(async () => first.resolve(summary(1)));
  expect(host.textContent).toBe('8');
  expect(h.load.mock.calls.map((call) => call[1])).toEqual(['a', 'b']);
});
it('hides completed old results during a workspace switch', async () => {
  h.load
    .mockResolvedValueOnce(summary(3))
    .mockReturnValueOnce(pending().promise);
  await render();
  expect(host.textContent).toBe('3');
  h.accountId = 'b';
  await render();
  expect(hook.data).toBeNull();
  expect(host.textContent).toBe('loading');
});
it('shows an error and can retry without stale values', async () => {
  h.load
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValueOnce(summary(9));
  await render();
  expect(hook.error).toBe(true);
  expect(hook.loading).toBe(false);
  await act(async () => hook.retry());
  expect(hook.error).toBe(false);
  expect(hook.data?.human.thisWeekAvg).toBe(9);
});
it('reloads when the workspace timezone changes and waits for ready membership', async () => {
  h.accountStatus = 'loading';
  h.load.mockResolvedValue(summary(4));
  await render();
  expect(h.load).not.toHaveBeenCalled();
  h.accountStatus = 'ready';
  await render();
  expect(h.load).toHaveBeenCalledTimes(1);
  h.defaultTimezone = 'Asia/Kolkata';
  await render();
  expect(h.load).toHaveBeenCalledTimes(2);
});
