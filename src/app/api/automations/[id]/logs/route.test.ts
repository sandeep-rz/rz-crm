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
it('returns reservation and queue metadata while excluding technical diagnostics', async () => {
  h.logs = [
    {
      id: 'execution',
      status: 'failed',
      trigger_job_id: 'job',
      trigger_job_attempt_count: 1,
      trigger_job_execution_state: 'failed',
      trigger_event: 'reservation_confirmed',
      created_at: '2026-10-07T00:00:00Z',
      error_message:
        'variable_missing; variable_key=secret.variable; ACCESS_TOKEN=private',
      contact: { id: 'private-contact-id', name: 'Taylor', phone: '+123' },
      trigger_job: {
        status: 'scheduled',
        attempt_count: 1,
        reservation: { reservation_code: 'BOOK-102' },
      },
      steps_executed: [
        {
          step_id: 'private-step-id',
          step_type: 'send_template',
          status: 'failed',
          detail: 'runtime_provider_failure; PRIVATE PROVIDER PAYLOAD',
        },
      ],
      user_id: 'private-user-id',
    },
  ];
  const response = await GET(request, params);
  const body = await response.json();
  expect(body.logs[0]).toMatchObject({
    reservation_reference: 'BOOK-102',
    job_status: 'scheduled',
    job_attempt_count: 1,
    failure_reason: 'variables',
  });
  expect(body.logs[0].steps_executed[0]).toEqual({
    step_type: 'send_template',
    status: 'failed',
    failure_reason: 'variables',
  });
  expect(JSON.stringify(body)).not.toMatch(
    /private|PRIVATE|error_message|step_id|variable_key|ACCESS_TOKEN|trigger_job"/
  );
});
it.each([
  ['template_connection_invalid', 'connection'],
  ['template_not_sendable', 'template'],
  ['template_target_invalid_recipient', 'recipient'],
  ['meta_send_failed_http_400_code_132018', 'templateSend'],
  ['Raw stack trace with access_token=PRIVATE', 'generic'],
])(
  'maps %s to a safe presentation category without changing eligibility',
  async (error_message, reason) => {
    h.logs = [
      {
        id: 'execution',
        trigger_job_id: 'job',
        status: 'failed',
        error_message,
        steps_executed: [],
      },
    ];
    const body = await (await GET(request, params)).json();
    expect(body.logs[0].failure_reason).toBe(reason);
    expect(body.logs[0].manual_retry_state).toBe('eligible');
    expect(JSON.stringify(body)).not.toContain(error_message);
  }
);
it('retains distinct historical attempts with advisory eligibility from the existing RPC', async () => {
  h.logs = [
    {
      id: 'new',
      trigger_job_id: 'job',
      status: 'success',
      trigger_job_attempt_count: 2,
    },
    {
      id: 'old',
      trigger_job_id: 'job',
      status: 'failed',
      trigger_job_attempt_count: 1,
    },
  ];
  h.states.mockResolvedValue({
    data: [
      { log_id: 'new', retry_state: 'already_completed' },
      { log_id: 'old', retry_state: 'already_completed' },
    ],
    error: null,
  });
  const body = await (await GET(request, params)).json();
  expect(
    body.logs.map((log: { id: string; status: string }) => [log.id, log.status])
  ).toEqual([
    ['new', 'success'],
    ['old', 'failed'],
  ]);
  expect(h.states).toHaveBeenCalledTimes(1);
});
