import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  userError: null as { message: string } | null,
  rpcResult: { data: '11111111-1111-1111-1111-111111111111', error: null } as {
    data: string | null;
    error: { code: string; message: string } | null;
  },
  rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: h.user },
        error: h.userError,
      })),
    },
    rpc: h.rpc,
  })),
}));

import { POST } from './route';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

function switchRequest(body: unknown) {
  return POST(
    new Request('http://localhost/api/account/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.user = { id: 'user-1' };
  h.userError = null;
  h.rpcResult = { data: ACCOUNT_ID, error: null };
  h.rpc.mockImplementation(async () => h.rpcResult);
});

describe('POST /api/account/switch', () => {
  it('requires authentication', async () => {
    h.user = null;
    const response = await switchRequest({ accountId: ACCOUNT_ID });

    expect(response.status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('validates accountId before calling the RPC', async () => {
    const response = await switchRequest({ accountId: 'not-a-uuid' });

    expect(response.status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('calls switch_account with only the selected account id', async () => {
    const response = await switchRequest({
      accountId: ACCOUNT_ID,
      userId: 'attacker-controlled',
    });

    expect(response.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('switch_account', {
      p_account_id: ACCOUNT_ID,
    });
    expect(await response.json()).toEqual({ ok: true, accountId: ACCOUNT_ID });
  });

  it('rejects an account the RPC says the caller does not belong to', async () => {
    h.rpcResult = {
      data: null,
      error: { code: '42501', message: 'You are not a member of this account' },
    };

    const response = await switchRequest({ accountId: ACCOUNT_ID });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'You are not a member of this account',
    });
  });
});
