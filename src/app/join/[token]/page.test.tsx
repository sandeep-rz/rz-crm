// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import JoinPage from './page';
const h = vi.hoisted(() => ({
  token: 'token-A',
  fetch: vi.fn(),
  translate: Object.assign((key: string) => key, {
    rich: (key: string, values: { name?: string }) =>
      `${key} ${values.name ?? ''}`,
  }),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ token: h.token }) }));
vi.mock('next-intl', async (original) => ({
  ...(await original<typeof import('next-intl')>()),
  useTranslations: () => h.translate,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));
let host: HTMLDivElement, root: Root;
const valid = (account_name = 'Workspace') => ({
  ok: true,
  account_name,
  role: 'agent',
  expires_at: '2026-12-01T00:00:00Z',
});
async function render() {
  await act(async () => root.render(<JoinPage />));
}
beforeEach(() => {
  h.token = 'token-A';
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it('renders a rate-limit explanation with a working retry instead of treating it as an invalid invitation', async () => {
  h.fetch
    .mockResolvedValueOnce(
      Response.json({ error: 'Too many requests' }, { status: 429 })
    )
    .mockResolvedValueOnce(Response.json(valid()));
  await render();
  expect(host.textContent).toContain('fail.rateLimitedTitle');
  const retry = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === 'tryAgain'
  )!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(host.textContent).not.toContain('fail.rateLimitedTitle');
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(host.querySelector('a[href*="signup"]')).not.toBeNull();
});
it.each([
  Response.json({ ok: true }),
  new Response('bad upstream', { status: 502 }),
])('offers retry for malformed responses', async (response) => {
  h.fetch.mockResolvedValue(response);
  await render();
  expect(host.textContent).toContain('fail.serverErrorTitle');
  expect(host.textContent).toContain('tryAgain');
});
it('keeps expired invitations terminal without retrying or redeeming them', async () => {
  h.fetch.mockResolvedValue(Response.json({ ok: false, reason: 'expired' }));
  await render();
  expect(host.textContent).toContain('fail.expiredTitle');
  expect(host.textContent).not.toContain('tryAgain');
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('ignores a response for an old invitation after navigation', async () => {
  let finish!: (response: Response) => void;
  h.fetch
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
    )
    .mockResolvedValueOnce(Response.json({ ok: false, reason: 'expired' }));
  await render();
  h.token = 'token-B';
  await render();
  await act(async () => finish(Response.json(valid('Old workspace'))));
  expect(host.textContent).toContain('fail.expiredTitle');
  expect(host.textContent).not.toContain('Old workspace');
});
