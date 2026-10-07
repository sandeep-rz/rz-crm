import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ auth: vi.fn(), retry: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.auth,
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/automations/manual-retry', async (original) => ({
  ...(await original<object>()),
  retryPmsAutomationExecution: h.retry,
}));
import { POST } from './route';
import { ManualRetryError } from '@/lib/automations/manual-retry';
const id = '11111111-1111-4111-8111-111111111111';
const request = () =>
  new Request('http://localhost/api/automations/executions/' + id + '/retry', {
    method: 'POST',
    body: JSON.stringify({ accountId: 'ATTACKER', runEngine: true }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  h.auth.mockResolvedValue({ accountId: 'active-account', userId: 'user' });
  h.retry.mockResolvedValue('queued');
});
it('requires agent permission and returns 202 for queueing without synchronous execution', async () => {
  const result = await POST(request(), { params: Promise.resolve({ id }) });
  expect(result.status).toBe(202);
  expect(await result.json()).toEqual({ status: 'queued' });
  expect(h.auth).toHaveBeenCalledWith('agent');
  expect(h.retry).toHaveBeenCalledExactlyOnceWith('active-account', id);
});
it('denies unauthenticated/viewer callers', async () => {
  h.auth.mockRejectedValue(new Error('private'));
  expect(
    (await POST(request(), { params: Promise.resolve({ id }) })).status
  ).toBe(403);
  expect(h.retry).not.toHaveBeenCalled();
});
it.each([
  'already_completed',
  'already_retried',
  'not_failed',
  'unsafe_to_retry',
] as const)('returns controlled %s conflict', async (code) => {
  h.retry.mockRejectedValue(new ManualRetryError(code));
  const response = await POST(request(), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe(code);
});
it('does not leak raw SQL/provider errors', async () => {
  h.retry.mockRejectedValue(new Error('SECRET PRIVATE SQL'));
  const response = await POST(request(), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('SECRET');
});
it('rejects invalid or foreign execution identifiers', async () => {
  const invalid = await POST(request(), {
    params: Promise.resolve({ id: 'invalid' }),
  });
  expect(invalid.status).toBe(404);
  expect(h.retry).not.toHaveBeenCalled();
  h.retry.mockRejectedValue(new ManualRetryError('not_found'));
  expect(
    (await POST(request(), { params: Promise.resolve({ id }) })).status
  ).toBe(404);
});
