import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  full: false,
  denied: false,
  limited: false,
  mode: 'coexistence',
  phone: '456',
  waba: '123',
  write: vi.fn(),
  register: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { whatsappAdmin: { limit: 30, windowMs: 60000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.mock('@/lib/auth/account', async (original) => {
  const actual = await original<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: async () => {
      if (h.denied) throw new actual.ForbiddenError();
      const { createClient } = await import('@/lib/supabase/server');
      return {
        supabase: await createClient(),
        accountId: 'account',
        userId: 'user',
        role: 'owner',
      };
    },
  };
});
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: () => 'encrypted' }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: async () => ({ display_phone_number: '15551234567' }),
  listWabaPhoneNumbers: async () => [{ id: h.phone }],
  registerPhoneNumber: h.register,
  subscribeWabaToApp: h.subscribe,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async () => ({ error: h.full ? { code: '23514' } : null }),
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        neq: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return b;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user' } }, error: null }),
    },
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        update: h.write,
        maybeSingle: async () => ({
          data:
            table === 'profiles'
              ? { account_id: 'account' }
              : {
                  id: 'connection',
                  phone_number_id: '456',
                  waba_id: '123',
                  registered_at: 'past',
                  verify_token: null,
                  onboarding_metadata: { onboarding_mode: h.mode },
                },
          error: null,
        }),
      };
      return b;
    },
  }),
}));
import { POST } from './route';
const request = () =>
  new Request('http://localhost/api/whatsapp/config', {
    method: 'POST',
    body: JSON.stringify({
      id: 'connection',
      phone_number_id: h.phone,
      waba_id: h.waba,
      access_token: 'token',
      pin: '123456',
    }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.full = false;
  h.denied = false;
  h.limited = false;
  h.mode = 'coexistence';
  h.phone = '456';
  h.waba = '123';
  h.write.mockImplementation(() => {
    const b = {
      eq: () => b,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    };
    return b;
  });
});
it('rejects manual replacement of a coexistence phone or WABA before registration or persistence', async () => {
  for (const [phone, waba] of [
    ['789', '123'],
    ['456', '999'],
  ]) {
    h.phone = phone;
    h.waba = waba;
    expect((await POST(request())).status).toBe(409);
  }
  expect(h.register).not.toHaveBeenCalled();
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
});
it('allows same-identity coexistence credential updates without registration', async () => {
  expect((await POST(request())).status).toBe(200);
  expect(h.write).toHaveBeenCalledOnce();
  expect(h.register).not.toHaveBeenCalled();
});
it('preserves standard Cloud API manual replacement and PIN registration', async () => {
  h.mode = 'cloud_api';
  h.phone = '789';
  expect((await POST(request())).status).toBe(200);
  expect(h.register).toHaveBeenCalledOnce();
  expect(h.write).toHaveBeenCalledOnce();
});

it('rejects manual addition when the workspace slot is occupied before registration or persistence', async () => {
  h.full = true;
  h.phone = '999';
  expect((await POST(request())).status).toBe(409);
  expect(h.register).not.toHaveBeenCalled();
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
});

it('refuses a non-admin before making Meta calls or writing connection state', async () => {
  h.denied = true;
  expect((await POST(request())).status).toBe(403);
  expect(h.register).not.toHaveBeenCalled();
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
});

it('rate-limits setup before Meta calls and local writes', async () => {
  h.limited = true;
  expect((await POST(request())).status).toBe(429);
  expect(h.register).not.toHaveBeenCalled();
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
});
