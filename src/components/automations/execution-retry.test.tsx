// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExecutionRetry } from './execution-retry';
const h = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it.each(['already_completed', 'not_eligible', undefined] as const)(
  'hides Retry for %s',
  async (state) => {
    await act(async () =>
      root.render(
        <ExecutionRetry logId="log" state={state} onQueued={() => {}} />
      )
    );
    expect(host.querySelector('button')).toBeNull();
  }
);
it('shows queued state without a button', async () => {
  await act(async () =>
    root.render(
      <ExecutionRetry logId="log" state="already_retried" onQueued={() => {}} />
    )
  );
  expect(host.textContent).toBe('retryQueued');
  expect(host.querySelector('button')).toBeNull();
});
it('double click makes one request, disables Retry, then shows Queued and toast', async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      })
  );
  vi.stubGlobal('fetch', fetch);
  const onQueued = vi.fn();
  await act(async () =>
    root.render(
      <ExecutionRetry logId="log" state="eligible" onQueued={onQueued} />
    )
  );
  await act(async () => {
    host.querySelector('button')!.click();
    host.querySelector('button')!.click();
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/automations/executions/log/retry',
    { method: 'POST' }
  );
  expect(host.querySelector('button')!.disabled).toBe(true);
  expect(host.textContent).toBe('retrying');
  await act(async () =>
    resolve(Response.json({ status: 'queued' }, { status: 202 }))
  );
  expect(host.querySelector('button')).toBeNull();
  expect(host.textContent).toBe('retryQueued');
  expect(onQueued).toHaveBeenCalledTimes(1);
  expect(h.success).toHaveBeenCalledWith('retrySuccess');
});
it('maps server failures to safe toast copy without displaying raw errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: 'unsafe_to_retry', error: 'PRIVATE SQL' },
          { status: 409 }
        )
      )
  );
  await act(async () =>
    root.render(
      <ExecutionRetry logId="log" state="eligible" onQueued={() => {}} />
    )
  );
  await act(async () => host.querySelector('button')!.click());
  expect(h.error).toHaveBeenCalledWith('retryIneligible');
  expect(host.textContent).not.toContain('PRIVATE');
});

it.each([
  ['already_completed', 'retryCompleted'],
  ['already_retried', 'retryAlreadyQueued'],
])(
  'handles a stale UI %s conflict without leaving Retry enabled',
  async (code, key) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ code }, { status: 409 }))
    );
    const onQueued = vi.fn();
    await act(async () =>
      root.render(
        <ExecutionRetry logId="log" state="eligible" onQueued={onQueued} />
      )
    );
    await act(async () => host.querySelector('button')!.click());
    expect(h.error).toHaveBeenCalledWith(key);
    expect(host.querySelector('button')).toBeNull();
    expect(onQueued).toHaveBeenCalledTimes(code === 'already_retried' ? 1 : 0);
  }
);
