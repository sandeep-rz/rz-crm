import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { encrypt } from '@/lib/whatsapp/encryption';
import { POST } from './route';
const h = vi.hoisted(() => ({
  role: vi.fn(),
  exchange: vi.fn(),
  sync: vi.fn(),
  validate: vi.fn(),
  activate: vi.fn(),
  verifyActivation: vi.fn(),
  rpc: vi.fn(),
  attempt: {} as Record<string, unknown>,
  writes: [] as { table: string; value: Record<string, unknown> }[],
  filters: [] as unknown[],
  conflict: '',
  failFinish: false,
}));
vi.mock('@/lib/whatsapp/coexistence-sync', () => ({
  resumeCoexistenceSync: h.sync,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.role,
  UnauthorizedError: class extends Error {},
  ForbiddenError: class extends Error {},
}));
vi.mock('@/lib/whatsapp/embedded-signup', async (original) => ({
  ...(await original<object>()),
  exchangeSignupCode: h.exchange,
  validateSignupToken: h.validate,
  activateSignup: h.activate,
  verifySignupActivation: h.verifyActivation,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      let update: Record<string, unknown> | undefined;
      const filters: [string, unknown][] = [];
      const result = () => {
        const matches = filters.every(
          ([key, value]) => h.attempt[key] === value
        );
        if (!matches) return { data: null, error: null };
        if (update) Object.assign(h.attempt, update);
        return { data: { ...h.attempt }, error: null };
      };
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          h.filters.push([table, key, value]);
          return q;
        },
        gte: () => q,
        not: () => q,
        neq: () => q,
        order: () => q,
        limit: () => q,
        insert: () => q,
        update: (value: Record<string, unknown>) => {
          update = value;
          h.writes.push({ table, value });
          return q;
        },
        single: async () => result(),
        maybeSingle: async () => result(),
        then: (resolve: (v: object) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      return q;
    },
    rpc: h.rpc,
  }),
}));
const id = '11111111-1111-1111-1111-111111111111';
const connection = '22222222-2222-2222-2222-222222222222';
const context = { waba_id: '123', phone_number_id: '456' };
const body = { action: 'complete', session_id: id, code: 'code', context };
const request = (value: object, origin = 'https://crm.test') =>
  new Request('https://crm.test/api/whatsapp/embedded-signup', {
    method: 'POST',
    headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.writes = [];
  h.filters = [];
  h.conflict = '';
  h.failFinish = false;
  h.attempt = {
    id,
    user_id: 'user',
    account_id: 'account',
    state: 'pending',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  h.role.mockResolvedValue({ userId: 'user', accountId: 'account' });
  const verified = {
    token: 'private-token',
    encryptedToken: encrypt('private-token'),
    displayPhone: '+123',
    wabaName: 'Customer',
    expiresAt: null,
  };
  h.exchange.mockResolvedValue(verified);
  h.validate.mockResolvedValue(verified);
  h.activate.mockResolvedValue({
    needsRegistration: false,
    registeredAt: '2026-10-08T12:00:00Z',
    subscribedAt: '2026-10-08T12:00:00Z',
  });
  h.verifyActivation.mockResolvedValue({
    registeredAt: '2026-10-08T12:00:00Z',
    subscribedAt: '2026-10-08T12:00:00Z',
  });
  h.rpc.mockImplementation(async (name, args) => {
    if (name === h.conflict) return { error: { code: '23505' } };
    if (name === 'claim_whatsapp_signup') {
      Object.assign(h.attempt, {
        state: 'processing',
        lease_id: args.p_lease,
        completion_mode: args.p_mode || h.attempt.completion_mode,
        context: args.p_context || h.attempt.context,
        code_hash: args.p_hash || h.attempt.code_hash,
      });
      return { data: [{ ...h.attempt }], error: null };
    }
    if (name === 'reserve_whatsapp_signup') {
      Object.assign(h.attempt, {
        pending_access_token: args.p_token,
        connection_id: connection,
      });
      return { data: connection, error: null };
    }
    if (name === 'mark_whatsapp_registration') {
      Object.assign(h.attempt, {
        pending_registration_pin: args.p_encrypted_pin,
        registration_requested_at: new Date().toISOString(),
      });
      return { error: null };
    }
    if (name === 'mark_whatsapp_signup_coexistence') {
      h.attempt.onboarding_mode = h.attempt.completion_mode = 'coexistence';
      h.attempt.pending_metadata = {
        ...(h.attempt.pending_metadata as object),
        onboarding_mode: 'coexistence',
      };
      return { error: null };
    }
    if (name === 'release_whatsapp_signup') {
      if (args.p_lease === h.attempt.lease_id)
        Object.assign(h.attempt, { state: 'failed', lease_id: null });
      return { error: null };
    }
    if (name === 'assert_whatsapp_signup_lease') return { error: null };
    if (h.failFinish) return { error: { code: 'XX000' } };
    h.attempt.state = 'complete';
    return { data: null, error: null };
  });
});
it('stages encrypted credentials and finalizes only after activation', async () => {
  expect((await POST(request(body))).status).toBe(200);
  expect(h.rpc.mock.calls.map((call) => call[0])).toEqual([
    'claim_whatsapp_signup',
    'reserve_whatsapp_signup',
    'assert_whatsapp_signup_lease',
    'assert_whatsapp_signup_lease',
    'finish_whatsapp_signup',
  ]);
  expect(h.rpc.mock.calls[1][1].p_token).not.toBe('private-token');
  expect(h.writes.some((write) => write.table === 'whatsapp_config')).toBe(
    false
  );
});
it('rejects foreign origins before authentication', async () => {
  expect((await POST(request(body, 'https://attacker.test'))).status).toBe(403);
  expect(h.role).not.toHaveBeenCalled();
});
it.each([
  { ...body, context: {} },
  { ...body, session_id: 'invalid' },
  { ...body, context: { waba_id: '123' } },
  { ...body, context: { phone_number_id: '456' } },
])('rejects invalid sessions/context %#', async (value) => {
  expect((await POST(request(value))).status).toBe(400);
  expect(h.exchange).not.toHaveBeenCalled();
});
it('enforces user/account scope for recovery', async () => {
  h.attempt.account_id = 'foreign';
  expect(
    (await POST(request({ action: 'recover', session_id: id }))).status
  ).toBe(404);
  expect(h.validate).not.toHaveBeenCalled();
  expect(h.activate).not.toHaveBeenCalled();
  expect(h.filters).toContainEqual([
    'whatsapp_signup_attempts',
    'account_id',
    'account',
  ]);
});
it('rejects a busy lease before exchange', async () => {
  h.rpc.mockResolvedValueOnce({ error: { code: '55P03' } });
  expect((await POST(request(body))).status).toBe(409);
  expect(h.exchange).not.toHaveBeenCalled();
});
it('rejects ownership conflicts before external activation', async () => {
  h.conflict = 'reserve_whatsapp_signup';
  expect((await POST(request(body))).status).toBe(409);
  expect(h.activate).not.toHaveBeenCalled();
});
it('failed reconnect never writes replacement credentials or resets state on the live row', async () => {
  h.activate.mockRejectedValue(new Error('private-token'));
  const response = await POST(request(body));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private-token');
  expect(
    h.writes.every((write) => write.table === 'whatsapp_signup_attempts')
  ).toBe(true);
  expect(h.attempt.pending_access_token).toBeTruthy();
  expect(h.attempt.state).toBe('failed');
  expect(
    h.rpc.mock.calls.some((call) => call[0] === 'finish_whatsapp_signup')
  ).toBe(false);
});
it('recovers Meta success followed by DB finalization failure without another exchange', async () => {
  h.failFinish = true;
  expect((await POST(request(body))).status).toBe(503);
  expect(h.attempt.pending_access_token).toBeTruthy();
  h.failFinish = false;
  expect(
    (await POST(request({ action: 'recover', session_id: id }))).status
  ).toBe(200);
  expect(h.exchange).toHaveBeenCalledOnce();
  expect(h.validate).toHaveBeenCalledOnce();
  expect(h.validate.mock.calls[0]).toEqual([
    'private-token',
    context,
    'cloud_api',
  ]);
});
it('recovers an interrupted process from staged credentials and saved registration outcome', async () => {
  Object.assign(h.attempt, {
    state: 'processing',
    pending_access_token: encrypt('saved-token'),
    context,
    registration_requested_at: '2026-10-08T10:00:00Z',
    connection_id: connection,
  });
  expect(
    (await POST(request({ action: 'recover', connection_id: connection })))
      .status
  ).toBe(200);
  expect(h.exchange).not.toHaveBeenCalled();
  expect(h.validate).toHaveBeenCalledWith('saved-token', context, 'cloud_api');
  expect(h.activate).toHaveBeenCalledWith(
    context,
    'private-token',
    expect.objectContaining({ registrationRequested: true }),
    expect.any(Function),
    'cloud_api'
  );
});
it('persists the encrypted PIN and request marker in the attempt before registration', async () => {
  const register = vi.fn(async () => {
    expect(h.attempt.pending_registration_pin).toBe('encrypted-pin');
    expect(h.attempt.registration_requested_at).toBeTruthy();
    return '2026-10-08T12:00:00Z';
  });
  h.activate.mockResolvedValue({
    needsRegistration: true,
    encryptedPin: 'encrypted-pin',
    subscribedAt: '2026-10-08T12:00:00Z',
    register,
  });
  expect((await POST(request(body))).status).toBe(200);
  expect(register).toHaveBeenCalledOnce();
  expect(
    h.writes.every((write) => write.table === 'whatsapp_signup_attempts')
  ).toBe(true);
});
it('returns completed callbacks idempotently without Meta calls', async () => {
  Object.assign(h.attempt, {
    state: 'complete',
    context: { phone_number_id: '456', waba_id: '123' },
    code_hash: createHash('sha256').update('code').digest('hex'),
    connection_id: connection,
  });
  expect((await POST(request(body))).status).toBe(200);
  expect(h.exchange).not.toHaveBeenCalled();
  expect(h.rpc).not.toHaveBeenCalled();
});

it('does not finalize when final Meta verification fails after activation', async () => {
  h.verifyActivation.mockRejectedValueOnce(
    new Error('subscription no longer verified')
  );
  expect((await POST(request(body))).status).toBe(502);
  expect(
    h.rpc.mock.calls.some((call) => call[0] === 'finish_whatsapp_signup')
  ).toBe(false);
  expect(h.attempt.pending_access_token).toBeTruthy();
});
it('does not register or finalize when the registration-marker lease fence rejects the write', async () => {
  const register = vi.fn();
  h.activate.mockResolvedValue({
    needsRegistration: true,
    encryptedPin: 'encrypted-pin',
    register,
  });
  h.conflict = 'mark_whatsapp_registration';
  expect((await POST(request(body))).status).toBe(409);
  expect(register).not.toHaveBeenCalled();
  expect(h.verifyActivation).not.toHaveBeenCalled();
  expect(
    h.rpc.mock.calls.some((call) => call[0] === 'finish_whatsapp_signup')
  ).toBe(false);
});
it('does not finalize if the lease is lost during final Meta verification', async () => {
  h.verifyActivation.mockImplementationOnce(async () => {
    h.conflict = 'assert_whatsapp_signup_lease';
    return {
      registeredAt: '2026-10-08T12:00:00Z',
      subscribedAt: '2026-10-08T12:00:00Z',
    };
  });
  expect((await POST(request(body))).status).toBe(409);
  expect(
    h.rpc.mock.calls.some((call) => call[0] === 'finish_whatsapp_signup')
  ).toBe(false);
});
it('verifies Meta before calling finalization and sends only server verification timestamps', async () => {
  h.verifyActivation.mockImplementationOnce(async () => {
    expect(
      h.rpc.mock.calls.some((call) => call[0] === 'finish_whatsapp_signup')
    ).toBe(false);
    return {
      registeredAt: '2026-10-08T12:01:00Z',
      subscribedAt: '2026-10-08T12:02:00Z',
    };
  });
  expect(
    (
      await POST(
        request({
          ...body,
          p_registered_at: 'untrusted',
          p_subscribed_at: 'untrusted',
        })
      )
    ).status
  ).toBe(200);
  expect(
    h.rpc.mock.calls.find((call) => call[0] === 'finish_whatsapp_signup')![1]
  ).toMatchObject({
    p_registered_at: '2026-10-08T12:01:00Z',
    p_subscribed_at: '2026-10-08T12:02:00Z',
  });
});

it('Coexistence completion persists mode, skips registration and starts synchronization', async () => {
  const res = await POST(
    request({
      ...body,
      completion_event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    })
  );
  expect(res.status).toBe(200);
  expect(h.activate).toHaveBeenCalledWith(
    context,
    'private-token',
    expect.any(Object),
    expect.any(Function),
    'coexistence'
  );
  expect(
    h.rpc.mock.calls.find(([name]) => name === 'reserve_whatsapp_signup')?.[1]
      .p_metadata.onboarding_mode
  ).toBe('coexistence');
  expect(
    h.rpc.mock.calls.some(([name]) => name === 'mark_whatsapp_registration')
  ).toBe(false);
  expect(h.sync).toHaveBeenCalledOnce();
});
it('completed Coexistence callbacks are idempotent', async () => {
  const input = {
    ...body,
    completion_event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  };
  await POST(request(input));
  expect((await POST(request(input))).status).toBe(200);
  expect(h.exchange).toHaveBeenCalledOnce();
  expect(h.activate).toHaveBeenCalledOnce();
});
it('rejects an unverified mode change on a completed standard attempt', async () => {
  await POST(request(body));
  expect(
    (
      await POST(
        request({
          ...body,
          completion_event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
        })
      )
    ).status
  ).toBe(409);
});
it('replays the original FINISH event after Meta confirms phone-number-first Coexistence', async () => {
  h.activate.mockResolvedValueOnce({
    needsRegistration: false,
    mode: 'coexistence',
  });
  expect((await POST(request(body))).status).toBe(200);
  expect(h.attempt.completion_mode).toBe('coexistence');
  expect((await POST(request(body))).status).toBe(200);
  expect(h.exchange).toHaveBeenCalledOnce();
  expect(h.activate).toHaveBeenCalledOnce();
  expect(
    h.rpc.mock.calls.some(([name]) => name === 'mark_whatsapp_registration')
  ).toBe(false);
});
it('reports unconfirmed Meta synchronization without undoing activation', async () => {
  h.sync.mockResolvedValueOnce(false);
  const res = await POST(
    request({
      ...body,
      completion_event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    })
  );
  expect(await res.json()).toMatchObject({ success: true, sync_pending: true });
});
it('reports synchronization recovery separately from successful connection activation', async () => {
  h.sync.mockRejectedValueOnce(new Error('sync failed'));
  const res = await POST(
    request({
      ...body,
      completion_event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    })
  );
  expect(await res.json()).toMatchObject({ success: true, sync_pending: true });
});
