import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  userError: null as { message: string } | null,
  rpcResult: {
    data: '11111111-1111-1111-1111-111111111111',
    error: null,
  } as {
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

function createRequest(body: unknown) {
  return POST(
    new Request('http://localhost/api/account/create', {
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

describe('POST /api/account/create', () => {
  it('requires authentication', async () => {
    h.user = null;

    const response = await createRequest({ name: 'One Tree' });

    expect(response.status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 400],
    [{ name: 123 }, 400],
    [{ name: '   ' }, 400],
    [{ name: 'x'.repeat(101) }, 400],
  ])('rejects an invalid workspace name', async (body, status) => {
    const response = await createRequest(body);

    expect(response.status).toBe(status);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('trims the name and calls only create_workspace', async () => {
    const response = await createRequest({ name: '  One Tree  ' });

    expect(response.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('create_workspace', {
      workspace_name: 'One Tree',
    });
    expect(await response.json()).toEqual({ ok: true, accountId: ACCOUNT_ID });
  });

  it('rejects privilege-related fields without calling the RPC', async () => {
    const response = await createRequest({
      name: 'Bad Test',
      userId: 'someone-else',
      role: 'owner',
    });

    expect(response.status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(['agent', 'admin'])(
    'returns 403 when the RPC denies a team-only %s',
    async () => {
      h.rpcResult = {
        data: null,
        error: {
          code: '42501',
          message: 'Only workspace owners can create additional workspaces',
        },
      };

      const response = await createRequest({ name: 'Denied' });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'You do not have permission to create a workspace',
      });
    }
  );

  it('does not expose unexpected database errors', async () => {
    h.rpcResult = {
      data: null,
      error: { code: 'P0001', message: 'sensitive database detail' },
    };

    const response = await createRequest({ name: 'One Tree' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Unable to create workspace',
    });
  });
});
