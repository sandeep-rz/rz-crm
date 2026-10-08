// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useSavedWhatsAppSignups } from './use-saved-whatsapp-signups';
let root: Root, host: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
function Probe({ account = 'a', user = 'u', enabled = true }) {
  const result = useSavedWhatsAppSignups(user, account, enabled);
  return (
    <div>
      {JSON.stringify(result.attempts)}
      {result.error}
    </div>
  );
}
const response = (account_id = 'a') =>
  new Response(
    JSON.stringify({
      account_id,
      attempts: [
        { id: 'durable-attempt', connection_id: null, recoverable: true },
      ],
    })
  );
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fetcher.mockReset().mockImplementation(async () => response());
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
it('discovers durable recovery on Settings mount and again after refresh', async () => {
  await act(() => root.render(<Probe />));
  expect(host.textContent).toContain('durable-attempt');
  await act(() => root.render(<Probe key="browser-refresh" />));
  expect(host.textContent).toContain('durable-attempt');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
});
it('does not discover attempts for users without Settings authorization', async () => {
  await act(() => root.render(<Probe enabled={false} />));
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('durable-attempt');
});
it('hides earlier account attempts immediately and ignores late responses', async () => {
  let resolve!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  await act(() => root.render(<Probe />));
  fetcher.mockImplementation(
    async () => new Response(JSON.stringify({ account_id: 'b', attempts: [] }))
  );
  await act(() => root.render(<Probe account="b" />));
  await act(() => resolve(response()));
  expect(host.textContent).not.toContain('durable-attempt');
});
it('rejects a server response for a different active workspace', async () => {
  fetcher.mockImplementation(async () => response('other'));
  await act(() => root.render(<Probe />));
  expect(host.textContent).toContain('Workspace changed');
  expect(host.textContent).not.toContain('durable-attempt');
});
