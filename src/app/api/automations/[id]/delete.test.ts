import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  deleted: [] as { id: string }[] | null,
  error: null as { message: string } | null,
  filters: [] as unknown[],
  allowed: true,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => {
    if (!h.allowed) throw new Error('forbidden');
    return { accountId: 'current-account' };
  },
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const query = {
        delete: () => query,
        eq: (key: string, value: unknown) => {
          h.filters.push([key, value]);
          return query;
        },
        select: async () => ({ data: h.deleted, error: h.error }),
      };
      return query;
    },
  }),
}));
import { DELETE } from './route';
const run = () =>
  DELETE(
    new Request('https://crm.test/api/automations/missing', {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ id: 'requested-id' }) }
  );
beforeEach(() => {
  h.deleted = [];
  h.error = null;
  h.filters = [];
  h.allowed = true;
});
it('returns 404 for a missing or foreign automation and retains account scope', async () => {
  expect((await run()).status).toBe(404);
  expect(h.filters).toEqual([
    ['id', 'requested-id'],
    ['account_id', 'current-account'],
  ]);
});
it('reports success only when an account-scoped row was deleted', async () => {
  h.deleted = [{ id: 'requested-id' }];
  const res = await run();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
it('does not issue a deletion for a caller without permission', async () => {
  h.allowed = false;
  expect((await run()).status).toBe(403);
  expect(h.filters).toEqual([]);
});
