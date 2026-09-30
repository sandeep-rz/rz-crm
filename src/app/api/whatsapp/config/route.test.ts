import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authenticated: true,
  accountId: 'workspace-1' as string | null,
  ownedConnection: true,
  ownershipError: null as { code?: string } | null,
  rpcData: null as string | null,
  rpcError: null as { code?: string; message?: string } | null,
  rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: state.authenticated ? { id: 'user-1' } : null },
        error: state.authenticated ? null : { message: 'unauthenticated' },
      })),
    },
    from: vi.fn((table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = vi.fn(chain);
      builder.eq = vi.fn(chain);
      builder.maybeSingle = vi.fn(async () => {
        if (table === 'profiles') {
          return {
            data: state.accountId ? { account_id: state.accountId } : null,
            error: null,
          };
        }
        if (table === 'whatsapp_config') {
          return {
            data: state.ownedConnection ? { id: 'connection-1' } : null,
            error: state.ownershipError,
          };
        }
        return { data: null, error: null };
      });
      return builder;
    }),
    rpc: state.rpc,
  })),
}));

import { DELETE } from './route';

function request(id = 'connection-1') {
  return new Request(`http://localhost/api/whatsapp/config?id=${id}`, {
    method: 'DELETE',
  });
}

describe('DELETE /api/whatsapp/config', () => {
  beforeEach(() => {
    state.authenticated = true;
    state.accountId = 'workspace-1';
    state.ownedConnection = true;
    state.ownershipError = null;
    state.rpcData = null;
    state.rpcError = null;
    state.rpc.mockReset();
    state.rpc.mockImplementation(async () => ({
      data: state.rpcData,
      error: state.rpcError,
    }));
  });

  it('delegates deletion and primary replacement to the atomic RPC exactly once', async () => {
    state.rpcData = 'connection-2';

    const response = await DELETE(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      promoted_connection_id: 'connection-2',
    });
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.rpc).toHaveBeenCalledWith('delete_whatsapp_connection', {
      connection_id: 'connection-1',
    });
  });

  it('allows the RPC to return no replacement for a non-primary or only connection', async () => {
    const response = await DELETE(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      promoted_connection_id: null,
    });
  });

  it('returns 401 before querying deletion state when unauthenticated', async () => {
    state.authenticated = false;

    const response = await DELETE(request());

    expect(response.status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('keeps cross-workspace connection ids tenant-safe', async () => {
    state.ownedConnection = false;

    const response = await DELETE(request('foreign-connection'));

    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('maps the RPC admin-or-owner denial to 403 without exposing PostgreSQL text', async () => {
    state.rpcError = { code: '42501', message: 'Insufficient permission' };

    const response = await DELETE(request());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: 'You do not have permission to delete this WhatsApp connection',
    });
    expect(JSON.stringify(body)).not.toContain('Insufficient permission');
  });

  it('maps an RPC not-found result to 404 and unexpected failures to 500', async () => {
    state.rpcError = {
      code: 'P0002',
      message: 'WhatsApp connection not found',
    };
    const missing = await DELETE(request());
    expect(missing.status).toBe(404);

    state.rpcError = { code: 'XX000', message: 'raw database failure' };
    const failed = await DELETE(request());
    const body = await failed.json();
    expect(failed.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to delete WhatsApp connection' });
    expect(JSON.stringify(body)).not.toContain('raw database failure');
  });
});
