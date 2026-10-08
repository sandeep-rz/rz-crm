import { beforeEach, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/account';
const h = vi.hoisted(() => ({
  role: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  rows: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.role,
  UnauthorizedError: class extends Error {
    status = 401;
  },
  ForbiddenError: class extends Error {
    status = 403;
  },
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: h.from, rpc: h.rpc }),
}));
const id = '11111111-1111-1111-1111-111111111111';
const row = (extra = {}) => ({
  id,
  user_id: 'u',
  account_id: 'a',
  connection_id: null,
  reconnect_id: null,
  context: { waba_id: '123', phone_number_id: '456' },
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60000).toISOString(),
  state: 'failed',
  discarded_at: null,
  pending_access_token: 'encrypted-secret',
  pending_registration_pin: 'encrypted-pin',
  code_hash: 'secret-hash',
  ...extra,
});
beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ userId: 'u', accountId: 'a' });
  h.rows = [row()];
  h.rpc.mockResolvedValue({ error: null });
  h.from.mockImplementation(() => {
    let rows = h.rows;
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        rows = rows.filter((r) => r[k] === v);
        return q;
      },
      neq: (k: string, v: unknown) => {
        rows = rows.filter((r) => r[k] !== v);
        return q;
      },
      is: (k: string, v: unknown) => {
        rows = rows.filter((r) => r[k] === v);
        return q;
      },
      order: async () => ({ data: rows, error: null }),
    };
    return q;
  });
});
it('discovers only own unfinished attempts, including no connection, without secrets', async () => {
  h.rows.push(
    row({ user_id: 'other' }),
    row({ account_id: 'other' }),
    row({ state: 'complete' }),
    row({ discarded_at: 'now' })
  );
  const response = await GET();
  expect(response.headers.get('cache-control')).toBe('no-store');
  const data = await response.json();
  expect(data.account_id).toBe('a');
  expect(data.attempts).toHaveLength(1);
  expect(data.attempts[0]).toMatchObject({
    id,
    connection_id: null,
    recoverable: true,
    busy: false,
  });
  expect(JSON.stringify(data)).not.toMatch(
    /encrypted|secret|code_hash|pending_access/
  );
});
it('reports active leases and expired authorization accurately', async () => {
  h.rows = [
    row({
      state: 'processing',
      lease_until: new Date(Date.now() + 60000).toISOString(),
    }),
    row({ expires_at: '2000-01-01' }),
  ];
  const { attempts } = await (await GET()).json();
  expect(attempts[0].busy).toBe(true);
  expect(attempts[1].recoverable).toBe(false);
});
it.each([new UnauthorizedError('login'), new ForbiddenError('admin required')])(
  'rejects unauthorized discovery and discard',
  async (error) => {
    h.role.mockRejectedValue(error);
    expect((await GET()).status).toBe(error.status);
    expect((await POST(request())).status).toBe(error.status);
    expect(h.from).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  }
);
function request(origin = 'https://crm.test') {
  return new Request('https://crm.test/api/whatsapp/embedded-signup', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'discard', session_id: id }),
  });
}
it('discards through the atomic own-user and workspace RPC without connection writes', async () => {
  expect((await POST(request())).status).toBe(200);
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith('discard_whatsapp_signup', {
    p_attempt: id,
    p_user: 'u',
    p_account: 'a',
  });
  expect(h.from).not.toHaveBeenCalled();
});
it.each(['42501', '55P03'])(
  'fails closed for foreign or busy attempts: %s',
  async (code) => {
    h.rpc.mockResolvedValue({ error: { code } });
    expect((await POST(request())).status).toBe(code === '42501' ? 403 : 409);
  }
);
it('rejects cross-origin discard', async () => {
  expect((await POST(request('https://foreign.test'))).status).toBe(403);
  expect(h.rpc).not.toHaveBeenCalled();
});
