import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  count: 0 as number | null,
  queryError: null as { message: string } | null,
  accountError: null as Error | null,
  eq: vi.fn(),
  neq: vi.fn(),
}));

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    ...actual,
    getCurrentAccount: vi.fn(async () => {
      if (state.accountError) throw state.accountError;
      const terminal = Promise.resolve({
        count: state.count,
        error: state.queryError,
      });
      const builder = {
        select: vi.fn(() => builder),
        eq: state.eq,
        neq: state.neq,
      } as Record<string, unknown>;
      state.eq.mockImplementation(() => builder);
      state.neq.mockImplementation(() => terminal);
      return {
        accountId: 'workspace-1',
        supabase: { from: vi.fn(() => builder) },
      };
    }),
  };
});

import { UnauthorizedError } from '@/lib/auth/account';
import { GET } from './route';

describe('GET /api/whatsapp/capability', () => {
  beforeEach(() => {
    state.count = 0;
    state.queryError = null;
    state.accountError = null;
    state.eq.mockReset();
    state.neq.mockReset();
  });

  it('reports an unavailable workspace without exposing connection rows', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      available: false,
      connectionCount: 0,
    });
  });

  it('reports all usable connected numbers for a multi-connection workspace', async () => {
    state.count = 2;
    const response = await GET();
    await expect(response.json()).resolves.toEqual({
      available: true,
      connectionCount: 2,
    });
  });

  it('scopes the capability query to the active workspace and connected status', async () => {
    await GET();
    expect(state.eq).toHaveBeenNthCalledWith(1, 'account_id', 'workspace-1');
    expect(state.eq).toHaveBeenNthCalledWith(2, 'status', 'connected');
    expect(state.neq).toHaveBeenCalledWith('phone_number_id', '');
  });

  it('keeps query failures distinct from an unconfigured workspace', async () => {
    state.queryError = { message: 'database unavailable' };
    const response = await GET();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to load WhatsApp capability',
    });
  });

  it('preserves authentication failures', async () => {
    state.accountError = new UnauthorizedError();
    const response = await GET();
    expect(response.status).toBe(401);
  });
});
