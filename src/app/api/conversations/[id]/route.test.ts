import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  role: vi.fn(),
  rpc: vi.fn(),
  cleanup: vi.fn(),
  update: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: h.role,
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({ update: h.update }) }),
}));
vi.mock('@/lib/inbox/delete-conversation', () => ({
  cleanupConversationMedia: h.cleanup,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.limit,
  RATE_LIMITS: { adminAction: {} },
  rateLimitResponse: () => new Response('{}', { status: 429 }),
}));
import { DELETE } from './route';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
const id = '55555555-0000-4000-8000-000000000000';
function request(body: unknown = { confirm: true, accountId: 'a' }) {
  return DELETE(
    new Request('http://localhost/api/conversations/' + id, {
      method: 'DELETE',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  h.role.mockResolvedValue({
    userId: 'u',
    accountId: 'a',
    supabase: { rpc: h.rpc },
  });
  h.rpc.mockResolvedValue({ data: { media_urls: ['media'] }, error: null });
  h.limit.mockReturnValue({ success: true });
  h.cleanup.mockResolvedValue([]);
  h.update.mockReturnValue({
    eq: () => ({ eq: async () => ({ error: null }) }),
  });
});
describe('permanent chat deletion API', () => {
  it('requires an authenticated admin', async () => {
    for (const [error, status] of [
      [new UnauthorizedError(), 401],
      [new ForbiddenError('Insufficient role'), 403],
    ] as const) {
      h.role.mockRejectedValueOnce(error);
      expect((await request()).status).toBe(status);
    }
    expect(h.role).toHaveBeenCalledWith('admin');
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('rejects missing confirmation, switched workspaces and rate limits', async () => {
    expect((await request({ confirm: false, accountId: 'a' })).status).toBe(
      400
    );
    expect((await request({ confirm: true, accountId: 'b' })).status).toBe(400);
    h.limit.mockReturnValue({ success: false });
    expect((await request()).status).toBe(429);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('scopes the atomic RPC to the current workspace and runs cleanup afterward', async () => {
    const response = await request();
    expect(await response.json()).toEqual({
      success: true,
      cleanupPending: false,
    });
    expect(h.rpc).toHaveBeenCalledWith('delete_conversation_permanently', {
      p_account: 'a',
      p_conversation: id,
    });
    expect(h.cleanup).toHaveBeenCalledOnce();
  });
  it('returns 404 or busy without attempting file cleanup', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect((await request()).status).toBe(404);
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'conversation_busy', code: 'P0001' },
    });
    expect((await request()).status).toBe(409);
    expect(h.cleanup).not.toHaveBeenCalled();
  });
  it('reports successful deletion even when storage cleanup fails', async () => {
    h.cleanup.mockRejectedValue(new Error('storage unavailable'));
    expect(await (await request()).json()).toEqual({
      success: true,
      cleanupPending: true,
    });
  });
});
