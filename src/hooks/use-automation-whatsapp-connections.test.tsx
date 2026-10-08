// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WhatsAppCapabilityProvider } from './use-whatsapp-capability';
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'account', user: { id: 'user' } }),
}));
import { useAutomationWhatsAppConnections } from './use-automation-whatsapp-connections';
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn<typeof fetch>();
function Page() {
  const connections = useAutomationWhatsAppConnections();
  return connections === null ? (
    <p>Loading page</p>
  ) : (
    <button disabled={!connections.some((c) => c.status === 'connected')}>
      Plus
    </button>
  );
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
it('loads once before showing the builder; subsequent menu interactions/renders do not recheck', async () => {
  let respond!: (r: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      })
  );
  await act(() =>
    root.render(
      <WhatsAppCapabilityProvider>
        <Page />
      </WhatsAppCapabilityProvider>
    )
  );
  expect(host.textContent).toBe('Loading page');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(() =>
    respond(
      new Response(
        JSON.stringify({
          account_id: 'account',
          connections: [
            { id: 'connection', status: 'connected', phone_number_id: '123' },
          ],
        })
      )
    )
  );
  expect(host.querySelector('button')!.disabled).toBe(false);
  await act(() => {
    host.querySelector('button')!.click();
    root.render(
      <WhatsAppCapabilityProvider>
        <Page />
      </WhatsAppCapabilityProvider>
    );
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { connections: [] },
  { connections: [{ id: 'connection', status: 'disconnected' }] },
])(
  'disables actions immediately for unavailable connections %j',
  async ({ connections }) => {
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ account_id: 'account', connections }))
    );
    await act(() =>
      root.render(
        <WhatsAppCapabilityProvider>
          <Page />
        </WhatsAppCapabilityProvider>
      )
    );
    expect(host.querySelector('button')!.disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
);
it('keeps actions disabled when the page-load check fails', async () => {
  fetcher.mockRejectedValue(new Error('Unavailable'));
  await act(() =>
    root.render(
      <WhatsAppCapabilityProvider>
        <Page />
      </WhatsAppCapabilityProvider>
    )
  );
  expect(host.querySelector('button')!.disabled).toBe(true);
});
it('does not trust an unsuccessful response', async () => {
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ connections: [{ status: 'connected' }] }), {
      status: 401,
    })
  );
  await act(() =>
    root.render(
      <WhatsAppCapabilityProvider>
        <Page />
      </WhatsAppCapabilityProvider>
    )
  );
  expect(host.querySelector('button')!.disabled).toBe(true);
});
