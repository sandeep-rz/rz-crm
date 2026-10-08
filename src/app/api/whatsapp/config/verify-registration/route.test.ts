import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
const h = vi.hoisted(() => ({
  verify: vi.fn(),
  subscribed: vi.fn(),
  decrypt: vi.fn(),
  filters: [] as unknown[],
  authenticated: true,
  config: null as Record<string, unknown> | null,
}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<object>()),
  verifyPhoneNumber: h.verify,
  getSubscribedApps: h.subscribed,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: h.decrypt }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: h.authenticated ? { id: 'user' } : null },
        error: null,
      }),
    },
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: (field: string, value: unknown) => {
          h.filters.push([table, field, value]);
          return q;
        },
        maybeSingle: async () => ({
          data: table === 'profiles' ? { account_id: 'account' } : h.config,
          error: null,
        }),
      };
      return q;
    },
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('META_APP_ID', 'our-app');
  h.filters = [];
  h.authenticated = true;
  h.config = {
    id: 'connection',
    phone_number_id: '123',
    waba_id: '456',
    access_token: 'ENCRYPTED',
    registered_at: 'recorded',
    status: 'connected',
  };
  h.decrypt.mockReturnValue('PRIVATE_TOKEN');
  h.verify.mockResolvedValue({ verified_name: 'Public name' });
  h.subscribed.mockResolvedValue([
    { whatsapp_business_api_data: { id: 'our-app' } },
  ]);
});
afterEach(() => vi.unstubAllEnvs());
const request = () =>
  new Request(
    'http://localhost/api/whatsapp/config/verify-registration?id=connection'
  );
it('performs explicit live checks and keeps local registration separate', async () => {
  const payload = await (await GET(request())).json();
  expect(h.verify).toHaveBeenCalledWith({
    phoneNumberId: '123',
    accessToken: 'PRIVATE_TOKEN',
  });
  expect(h.subscribed).toHaveBeenCalledWith({
    wabaId: '456',
    accessToken: 'PRIVATE_TOKEN',
  });
  expect(h.filters).toContainEqual([
    'whatsapp_config',
    'account_id',
    'account',
  ]);
  expect(h.filters).toContainEqual(['whatsapp_config', 'id', 'connection']);
  expect(payload).toMatchObject({
    live: true,
    verified: true,
    phone_info: { verified_name: 'Public name' },
    waba_subscription: { checked: true, subscribed: true, app_id_match: true },
    checks: { locally_marked_registered: true, waba_subscribed_to_app: true },
    checked_at: expect.any(String),
  });
  expect(JSON.stringify(payload)).not.toMatch(
    /ENCRYPTED|PRIVATE_TOKEN|access_token/
  );
});
it('does not report live when only a different app is subscribed', async () => {
  h.subscribed.mockResolvedValue([
    { whatsapp_business_api_data: { id: 'different-app' } },
  ]);
  const payload = await (await GET(request())).json();
  expect(payload).toMatchObject({
    live: false,
    verified: true,
    waba_subscription: { checked: true, subscribed: true, app_id_match: false },
    checks: { waba_subscribed_to_app: false, locally_marked_registered: true },
  });
  expect(payload.errors).toContain(
    'The configured Meta app is not subscribed to this WABA. Re-save the configuration to subscribe.'
  );
});
it('reports no subscription when there are no subscribed apps', async () => {
  h.subscribed.mockResolvedValue([]);
  const payload = await (await GET(request())).json();
  expect(payload).toMatchObject({
    live: false,
    waba_subscription: {
      checked: true,
      subscribed: false,
      app_id_match: false,
    },
    checks: { waba_subscribed_to_app: false },
  });
  expect(payload.errors).toContain(
    'WABA has no subscribed apps. Re-save the configuration to subscribe.'
  );
});
it.each([undefined, '', '   '])(
  'never reports an app match or live connection with META_APP_ID=%s',
  async (appId) => {
    vi.stubEnv('META_APP_ID', appId);
    const payload = await (await GET(request())).json();
    expect(payload).toMatchObject({
      live: false,
      verified: true,
      waba_subscription: {
        checked: true,
        subscribed: true,
        app_id_match: null,
      },
      checks: { waba_subscribed_to_app: null },
    });
    expect(payload.errors).toContain(
      "META_APP_ID is not configured. Cannot verify this app's WABA subscription."
    );
  }
);
it('still requires phone verification even when our app is subscribed', async () => {
  h.verify.mockRejectedValue(new Error('Meta unavailable'));
  const payload = await (await GET(request())).json();
  expect(payload).toMatchObject({
    live: false,
    verified: false,
    checks: {
      phone_metadata_ok: false,
      waba_subscribed_to_app: true,
      locally_marked_registered: true,
    },
  });
});
it('phone verification alone never claims registration or a fully live connection', async () => {
  h.config!.registered_at = null;
  const payload = await (await GET(request())).json();
  expect(payload).toMatchObject({
    verified: true,
    live: false,
    checks: { locally_marked_registered: false },
  });
});
it('verification failure does not alter stored local state', async () => {
  h.verify.mockRejectedValue(new Error('Meta unavailable'));
  h.subscribed.mockRejectedValue(new Error('Meta unavailable'));
  const payload = await (await GET(request())).json();
  expect(payload).toMatchObject({
    live: false,
    verified: false,
    waba_subscription: { checked: true, subscribed: null },
    checks: { phone_metadata_ok: false },
  });
  expect(h.config).toMatchObject({
    status: 'connected',
    registered_at: 'recorded',
  });
});
it('decryption failure never calls Meta', async () => {
  h.decrypt.mockImplementation(() => {
    throw new Error('PRIVATE_KEY');
  });
  const payload = await (await GET(request())).json();
  expect(payload).toMatchObject({
    live: false,
    checks: { token_decryptable: false },
  });
  expect(h.verify).not.toHaveBeenCalled();
  expect(h.subscribed).not.toHaveBeenCalled();
});
it('does not verify absent/foreign connection or unauthenticated requests', async () => {
  h.config = null;
  await GET(request());
  expect(h.verify).not.toHaveBeenCalled();
  h.authenticated = false;
  expect((await GET(request())).status).toBe(401);
});
