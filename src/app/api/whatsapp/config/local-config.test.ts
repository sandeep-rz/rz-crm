import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
const h = vi.hoisted(() => ({
  verify: vi.fn(),
  subscribed: vi.fn(),
  decrypt: vi.fn(),
  authenticated: true,
  account: 'account-a' as string | null,
  rows: [] as Record<string, unknown>[],
  error: null as unknown,
  queries: [] as { table: string; select: string; filters: unknown[] }[],
}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<object>()),
  verifyPhoneNumber: h.verify,
  getSubscribedApps: h.subscribed,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn(),
  decrypt: h.decrypt,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: h.authenticated ? { id: 'user' } : null },
        error: null,
      }),
    },
    from: (table: string) => {
      const query = { table, select: '', filters: [] as unknown[] };
      h.queries.push(query);
      const q = {
        select: (fields: string) => {
          query.select = fields;
          return q;
        },
        eq: (field: string, value: unknown) => {
          query.filters.push([field, value]);
          return q;
        },
        order: () => q,
        maybeSingle: async () => ({
          data: h.account ? { account_id: h.account } : null,
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: h.rows, error: h.error }).then(resolve),
      };
      return q;
    },
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  h.authenticated = true;
  h.account = 'account-a';
  h.error = null;
  h.queries = [];
  h.rows = [
    {
      id: 'a',
      display_name: 'Main',
      is_primary: true,
      status: 'connected',
      phone_number_id: '123',
      registered_at: 'past-registration',
      subscribed_apps_at: 'past-subscription',
      verify_token: 'ENCRYPTED_SECRET',
      access_token: 'PRIVATE_TOKEN',
      app_secret: 'PRIVATE_APP_SECRET',
    },
  ];
});
it('reads local account-owned metadata only, without decrypting or contacting Meta', async () => {
  h.verify.mockImplementation(() => new Promise(() => {}));
  const response = await GET(
    new Request('http://localhost/api/whatsapp/config')
  );
  expect(response.status).toBe(200);
  expect(h.queries.map((q) => q.table)).toEqual([
    'profiles',
    'whatsapp_config',
  ]);
  expect(h.queries[1].filters).toContainEqual(['account_id', 'account-a']);
  expect(h.queries[1].select).not.toContain('access_token');
  expect(h.decrypt).not.toHaveBeenCalled();
  expect(h.verify).not.toHaveBeenCalled();
  expect(h.subscribed).not.toHaveBeenCalled();
  const payload = await response.json();
  expect(payload).toMatchObject({
    account_id: 'account-a',
    configured: true,
    selected_connection_id: 'a',
    connections: [
      expect.objectContaining({
        has_verify_token: true,
        registered_at: 'past-registration',
        subscribed_apps_at: 'past-subscription',
      }),
    ],
  });
  for (const field of [
    'connected',
    'verified',
    'registered',
    'subscribed',
    'healthy',
    'phone_info',
    'waba_subscription',
  ])
    expect(payload).not.toHaveProperty(field);
  expect(JSON.stringify(payload)).not.toMatch(
    /PRIVATE|ENCRYPTED|access_token|app_secret/
  );
  expect(payload.connections[0]).not.toHaveProperty('verify_token');
});
it('returns no configuration distinctly from an error', async () => {
  h.rows = [];
  const response = await GET(
    new Request('http://localhost/api/whatsapp/config')
  );
  expect(await response.json()).toEqual({
    account_id: 'account-a',
    configured: false,
    connections: [],
    selected_connection_id: null,
  });
  h.error = new Error('PRIVATE DB DETAIL');
  expect(
    (await GET(new Request('http://localhost/api/whatsapp/config'))).status
  ).toBe(500);
});
it('returns a collection even when multiple connections have no primary', async () => {
  h.rows = [
    { id: 'a', is_primary: false },
    { id: 'b', is_primary: false },
  ];
  const response = await GET(
    new Request('http://localhost/api/whatsapp/config')
  );
  expect(response.status).toBe(200);
  expect((await response.json()).selected_connection_id).toBeNull();
});
it('rejects another account connection selection', async () => {
  expect(
    (await GET(new Request('http://localhost/api/whatsapp/config?id=foreign')))
      .status
  ).toBe(404);
});
it('requires authentication and active account', async () => {
  h.authenticated = false;
  expect(
    (await GET(new Request('http://localhost/api/whatsapp/config'))).status
  ).toBe(401);
  expect(h.queries).toEqual([]);
  h.authenticated = true;
  h.account = null;
  expect(
    (await GET(new Request('http://localhost/api/whatsapp/config'))).status
  ).toBe(403);
});
