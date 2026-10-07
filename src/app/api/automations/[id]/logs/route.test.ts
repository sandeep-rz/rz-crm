import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  states: vi.fn(),
  filters: [] as [string, string, unknown][],
  automation: {} as unknown,
  logs: [] as unknown[],
  dbError: null as unknown,
}));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: h.auth,
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: h.states,
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          h.filters.push([table, key, value]);
          return q;
        },
        order: () => q,
        limit: () => q,
        maybeSingle: () => q,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'automations' ? h.automation : h.logs,
            error: h.dbError,
          }).then(resolve),
      };
      return q;
    },
  }),
}));
import { GET } from './route';
const id = '11111111-1111-4111-8111-111111111111';
const request = new Request(`http://localhost/api/automations/${id}/logs`);
const params = { params: Promise.resolve({ id }) };
beforeEach(() => {
  vi.clearAllMocks();
  h.filters = [];
  h.automation = { id, account_id: 'active-account' };
  h.logs = [
    {
      id: 'execution',
      trigger_job_id: 'job',
      status: 'failed',
      trigger_job_attempt_count: 1,
    },
  ];
  h.dbError = null;
  h.auth.mockResolvedValue({ accountId: 'active-account', role: 'agent' });
  h.states.mockResolvedValue({
    data: [{ log_id: 'execution', retry_state: 'eligible' }],
    error: null,
  });
});
it('scopes automation and history to active account and enriches eligibility server-side', async () => {
  const response = await GET(request, params);
  expect(response.status).toBe(200);
  for (const table of ['automations', 'automation_logs'])
    expect(h.filters).toContainEqual([table, 'account_id', 'active-account']);
  expect(h.states).toHaveBeenCalledExactlyOnceWith(
    'get_pms_automation_retry_states',
    {
      p_account_id: 'active-account',
      p_log_ids: ['execution'],
    }
  );
  expect(
    h.filters.every(([table]) =>
      ['automations', 'automation_logs'].includes(table)
    )
  ).toBe(true);
  expect((await response.json()).logs[0].trigger_job_attempt_count).toBe(1);
});
it('viewers can read history but cannot obtain eligible Retry', async () => {
  h.auth.mockResolvedValue({ accountId: 'active-account', role: 'viewer' });
  const response = await GET(request, params);
  expect((await response.json()).logs[0].manual_retry_state).toBe(
    'not_eligible'
  );
  expect(h.states).not.toHaveBeenCalled();
});
it('foreign or deleted automation returns 404 without querying logs', async () => {
  h.automation = null;
  expect((await GET(request, params)).status).toBe(404);
  expect(h.filters.some(([table]) => table === 'automation_logs')).toBe(false);
  expect(h.states).not.toHaveBeenCalled();
});
it('requires authenticated workspace context', async () => {
  h.auth.mockRejectedValue(new Error('private'));
  expect((await GET(request, params)).status).toBe(403);
  expect(h.filters).toEqual([]);
});
it('database errors are controlled and contain no raw SQL', async () => {
  h.dbError = { message: 'SECRET SQL' };
  const response = await GET(request, params);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('SECRET');
});
