import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ role: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.role,
  UnauthorizedError: class extends Error {},
  ForbiddenError: class extends Error {},
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc: h.rpc, from: h.from }),
}));
import { GET, POST } from './route';
const request = (
  action: string,
  session_id = '11111111-1111-1111-1111-111111111111'
) =>
  new Request('https://crm.test/api/whatsapp/embedded-signup', {
    method: 'POST',
    headers: { origin: 'https://crm.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, session_id }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ accountId: 'a', userId: 'u' });
  h.rpc.mockResolvedValue({ error: null });
});
it('never exposes or reads saved setups', async () => {
  const response = await GET();
  expect(await response.json()).toEqual({ account_id: 'a', attempts: [] });
  expect(h.from).not.toHaveBeenCalled();
});
it.each(['discard', 'recover'])(
  'rejects obsolete %s actions without touching storage',
  async (action) => {
    expect((await POST(request(action))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  }
);
it('automatically cleans only the authenticated user and workspace session', async () => {
  expect((await POST(request('abandon'))).status).toBe(200);
  expect(h.rpc).toHaveBeenCalledWith('clear_unfinished_whatsapp_signup', {
    p_user: 'u',
    p_account: 'a',
    p_attempt: '11111111-1111-1111-1111-111111111111',
  });
});
