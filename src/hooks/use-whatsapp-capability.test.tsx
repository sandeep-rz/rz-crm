// @vitest-environment jsdom
import React, { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  WhatsAppCapabilityProvider,
  useWhatsAppCapability,
  type WhatsAppCapability,
} from './use-whatsapp-capability';
const h = vi.hoisted(() => ({
  accountId: 'a' as string | null,
  userId: 'user',
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: h.accountId, user: { id: h.userId } }),
}));
let root: Root, host: HTMLDivElement, latest: WhatsAppCapability;
const fetcher = vi.fn<typeof fetch>();
function Consumer({ name = 'screen' }: { name?: string }) {
  const capability = useWhatsAppCapability();
  useEffect(() => {
    latest = capability;
  }, [capability]);
  return (
    <p>
      {name}:{capability.status}:
      {capability.connections.map((r) => r.id).join(',')}:
      {capability.error ? 'retry' : ''}
    </p>
  );
}
function App({
  name = 'screen',
  many = false,
}: {
  name?: string;
  many?: boolean;
}) {
  return (
    <WhatsAppCapabilityProvider>
      <Consumer name={name} />
      {many && <Consumer name="nested" />}
    </WhatsAppCapabilityProvider>
  );
}
const data = (account = 'a', id = 'a-number', is_primary = true) => ({
  account_id: account,
  configured: true,
  selected_connection_id: id,
  connections: [
    {
      id,
      is_primary,
      display_name: id,
      status: 'connected',
      phone_number_id: '123',
    },
  ],
});
const response = (value = data()) => new Response(JSON.stringify(value));
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  h.accountId = 'a';
  h.userId = 'user';
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('deduplicates concurrent consumers and strict effect replays, then reuses state during navigation', async () => {
  let resolve!: (v: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  await act(() =>
    root.render(
      <StrictMode>
        <App many />
      </StrictMode>
    )
  );
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/whatsapp/config', {
    cache: 'no-store',
  });
  expect(latest.loading).toBe(true);
  await act(async () => {
    resolve(response());
  });
  expect(latest.available).toBe(true);
  expect(latest.primaryConnection?.id).toBe('a-number');
  await act(() =>
    root.render(
      <StrictMode>
        <App name="Broadcast" many />
      </StrictMode>
    )
  );
  expect(latest.loading).toBe(false);
  expect(host.textContent).toContain('Broadcast:available:a-number');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retains safe cached data during background refresh and failure', async () => {
  fetcher.mockResolvedValueOnce(response());
  await act(() => root.render(<App />));
  let reject!: (e: Error) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      })
  );
  let pending!: Promise<unknown>;
  await act(() => {
    pending = latest.refresh();
  });
  expect(latest.loading).toBe(false);
  expect(latest.refreshing).toBe(true);
  expect(latest.available).toBe(true);
  await act(async () => {
    reject(new Error('PRIVATE network detail'));
    await pending;
  });
  expect(latest.available).toBe(true);
  expect(latest.connections[0].id).toBe('a-number');
  expect(latest.error).toContain('retry');
  expect(host.textContent).not.toContain('PRIVATE');
});
it('hides account A immediately and ignores its late response after switching to B', async () => {
  const resolves: ((v: Response) => void)[] = [];
  fetcher.mockImplementation(() => new Promise((r) => resolves.push(r)));
  await act(() => root.render(<App />));
  h.accountId = 'b';
  await act(() => root.render(<App />));
  expect(latest.connections).toEqual([]);
  expect(latest.available).toBe(false);
  await act(async () => {
    resolves[0](response());
  });
  expect(latest.connections).toEqual([]);
  await act(async () => {
    resolves[1](response(data('b', 'b-number')));
  });
  expect(latest.connections[0].id).toBe('b-number');
});
it('rejects mismatched active-account responses and clears state on sign-out', async () => {
  fetcher.mockResolvedValue(response(data('wrong')));
  await act(() => root.render(<App />));
  expect(latest.status).toBe('error');
  expect(latest.connections).toEqual([]);
  h.accountId = null;
  await act(() => root.render(<App />));
  expect(latest.available).toBe(false);
  expect(latest.connections).toEqual([]);
});
it('distinguishes no connections from first-load failure and allows retry', async () => {
  fetcher.mockRejectedValueOnce(new Error('offline'));
  await act(() => root.render(<App />));
  expect(latest.status).toBe('error');
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({
        account_id: 'a',
        configured: false,
        connections: [],
        selected_connection_id: null,
      })
    )
  );
  await act(async () => {
    await latest.refresh();
  });
  expect(latest.status).toBe('unavailable');
  expect(latest.configured).toBe(false);
});
it('mutation invalidation reloads shared connection and primary state for all consumers', async () => {
  fetcher.mockResolvedValueOnce(response());
  await act(() => root.render(<App many />));
  fetcher.mockResolvedValueOnce(response(data('a', 'new-primary')));
  await act(async () => {
    await latest.invalidate();
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(latest.primaryConnection?.id).toBe('new-primary');
  expect(host.textContent).not.toContain('a-number');
});
it('invalidation does not accept an in-flight pre-mutation read as the final snapshot', async () => {
  let resolve!: (v: Response) => void;
  fetcher
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    )
    .mockResolvedValueOnce(response(data('a', 'after-mutation')));
  await act(() => root.render(<App />));
  let done!: Promise<unknown>;
  await act(() => {
    done = latest.invalidate();
  });
  await act(async () => {
    resolve(response());
    await done;
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(latest.connections[0].id).toBe('after-mutation');
});

it('successful disconnect invalidation removes the old cached connection', async () => {
  fetcher.mockResolvedValueOnce(response());
  await act(() => root.render(<App />));
  fetcher.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        account_id: 'a',
        configured: false,
        selected_connection_id: null,
        connections: [],
      })
    )
  );
  await act(async () => {
    await latest.invalidate();
  });
  expect(latest.status).toBe('unavailable');
  expect(latest.primaryConnection).toBeNull();
  expect(latest.connections).toEqual([]);
});

it('discards cached state when the server reports a different workspace', async () => {
  fetcher.mockResolvedValueOnce(response());
  await act(() => root.render(<App />));
  fetcher.mockResolvedValueOnce(response(data('b', 'b-number')));
  await act(async () => {
    await latest.refresh();
  });
  expect(latest.status).toBe('error');
  expect(latest.connections).toEqual([]);
  expect(latest.available).toBe(false);
});
it('propagates primary changes while retaining the multi-connection collection', async () => {
  const second = { ...data().connections[0], id: 'second', is_primary: false };
  fetcher.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ...data(),
        connections: [...data().connections, second],
      })
    )
  );
  await act(() => root.render(<App many />));
  expect(latest.primaryConnection?.id).toBe('a-number');
  fetcher.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ...data(),
        connections: [
          { ...data().connections[0], is_primary: false },
          { ...second, is_primary: true },
        ],
      })
    )
  );
  await act(async () => {
    await latest.invalidate();
  });
  expect(latest.primaryConnection?.id).toBe('second');
  expect(latest.connectionCount).toBe(2);
});
