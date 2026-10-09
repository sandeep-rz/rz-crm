import { beforeEach, expect, it, vi } from 'vitest';
import {
  activateSignup as activateWithLease,
  verifySignupActivation,
  exchangeSignupCode,
  validateSignupToken,
} from './embedded-signup';
import { decrypt } from './encryption';
import {
  signupContext,
  signupEvent,
  signupEligibilityError,
} from './embedded-signup-context';
const guard = vi.fn(async () => {});
const activateSignup = (
  context: Parameters<typeof activateWithLease>[0],
  token: string,
  recovery?: Parameters<typeof activateWithLease>[2]
) => activateWithLease(context, token, recovery, guard);
const h = vi.hoisted(() => ({
  numbers: vi.fn(),
  subscribe: vi.fn(),
  apps: vi.fn(),
}));
vi.mock('./meta-api', () => ({
  listWabaPhoneNumbers: h.numbers,
  subscribeWabaToApp: h.subscribe,
  getSubscribedApps: h.apps,
}));
const context = { waba_id: '123', phone_number_id: '456' };
const fetcher = vi.fn<typeof fetch>();
const validDebug = {
  is_valid: true,
  app_id: '1444327167651307',
  type: 'SYSTEM_USER',
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  expires_at: Math.floor(Date.now() / 1000) + 3600,
};
const response = (data: object, status = 200) =>
  new Response(JSON.stringify(data), { status });
beforeEach(() => {
  vi.clearAllMocks();
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  h.numbers.mockResolvedValue([{ id: '456', display_phone_number: '+12345' }]);
  h.subscribe.mockResolvedValue(undefined);
  h.apps
    .mockReset()
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      { whatsapp_business_api_data: { id: '1444327167651307' } },
    ]);
  fetcher
    .mockResolvedValueOnce(response({ access_token: 'private-business-token' }))
    .mockResolvedValueOnce(response({ data: validDebug }))
    .mockResolvedValueOnce(response({ id: '123', name: 'Customer' }));
});
it('exchanges server-side, validates assets and encrypts the business token', async () => {
  const result = await exchangeSignupCode('private-code', context);
  expect(decrypt(result.encryptedToken)).toBe('private-business-token');
  expect(result.encryptedToken).not.toContain('private-business-token');
  expect(result.wabaName).toBe('Customer');
  expect(fetcher.mock.calls[0][0]).not.toContain('private-code');
  expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
});
it('sanitizes code exchange failure', async () => {
  fetcher
    .mockReset()
    .mockResolvedValue(
      response({ error: { message: 'private-code private-token' } }, 400)
    );
  await expect(exchangeSignupCode('private-code', context)).rejects.toThrow(
    'expired or could not be exchanged'
  );
});
it.each([
  { ...validDebug, is_valid: false },
  { ...validDebug, app_id: 'foreign' },
  { ...validDebug, type: 'USER' },
  { ...validDebug, scopes: [] },
  { ...validDebug, expires_at: 1 },
  { ...validDebug, data_access_expires_at: 1 },
])('rejects invalid or insufficient token authorization %#', async (debug) => {
  fetcher
    .mockReset()
    .mockResolvedValueOnce(response({ access_token: 'token' }))
    .mockResolvedValueOnce(response({ data: debug }));
  await expect(exchangeSignupCode('code', context)).rejects.toThrow(
    'authorization is invalid'
  );
});
it('rejects WABA/phone mismatch', async () => {
  h.numbers.mockResolvedValue([{ id: '999' }]);
  await expect(exchangeSignupCode('code', context)).rejects.toThrow(
    'does not belong'
  );
});
it('subscribes and verifies already registered phones without registering again', async () => {
  fetcher
    .mockReset()
    .mockResolvedValue(response({ id: '456', status: 'CONNECTED' }));
  const result = await activateSignup(context, 'token');
  expect(result.needsRegistration).toBe(false);
  expect(h.subscribe).toHaveBeenCalledOnce();
  expect(h.apps).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('registers only when required and verifies the result, with encrypted recovery PIN', async () => {
  fetcher
    .mockReset()
    .mockResolvedValueOnce(response({ id: '456', status: 'PENDING' }))
    .mockResolvedValueOnce(response({ success: true }))
    .mockResolvedValueOnce(response({ id: '456', status: 'CONNECTED' }));
  const result = await activateSignup(context, 'token');
  expect(result.needsRegistration).toBe(true);
  if (!result.needsRegistration) throw new Error();
  const pin = decrypt(result.encryptedPin);
  expect(pin).toMatch(/^\d{6}$/);
  expect(fetcher).toHaveBeenCalledOnce(); // caller must persist PIN before registration
  await result.register();
  expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toEqual({
    messaging_product: 'whatsapp',
    pin,
  });
});
it('fails closed on webhook subscription failure', async () => {
  h.subscribe.mockRejectedValue(new Error('Meta unavailable'));
  await expect(activateSignup(context, 'token')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('fails when our app subscription cannot be verified', async () => {
  h.apps
    .mockReset()
    .mockResolvedValue([{ whatsapp_business_api_data: { id: 'other' } }]);
  await expect(activateSignup(context, 'token')).rejects.toThrow(
    'could not be verified'
  );
});
it('sanitizes Meta API failure', async () => {
  fetcher.mockReset().mockRejectedValue(new Error('secret-token'));
  await expect(activateSignup(context, 'token')).rejects.toThrow(
    'Meta could not complete'
  );
});
it.each([
  {},
  { waba_id: '123' },
  { phone_number_id: '456' },
  { waba_id: 123, phone_number_id: '456' },
])('rejects incomplete context %j', (value) =>
  expect(signupContext(value)).toBeNull()
);
it('validates exact event origin and structure', () => {
  const value = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: context };
  expect(
    signupEvent('https://www.facebook.com', JSON.stringify(value))
  ).toEqual({ event: 'FINISH', context });
  expect(
    signupEvent('https://www.facebook.com.attacker.test', value)
  ).toBeNull();
  expect(signupEvent('https://www.facebook.com', 'bad json')).toBeNull();
  expect(
    signupEvent('https://www.facebook.com', { ...value, data: {} })
  ).toEqual({ event: 'INCOMPLETE' });
});
it('captures cancellation without trusting extra data', () => {
  expect(
    signupEvent('https://web.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'CANCEL',
      data: { access_token: 'untrusted' },
    })
  ).toEqual({ event: 'CANCEL' });
});
it('reconciles already activated Meta state without repeating subscription or registration', async () => {
  h.apps
    .mockReset()
    .mockResolvedValue([
      { whatsapp_business_api_data: { id: '1444327167651307' } },
    ]);
  fetcher
    .mockReset()
    .mockResolvedValue(response({ id: '456', status: 'CONNECTED' }));
  const result = await activateSignup(context, 'token', {
    registrationRequested: true,
  });
  expect(result.needsRegistration).toBe(false);
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1]?.method).not.toBe('POST');
});
it('does not blindly repeat registration after an interrupted request with an unknown outcome', async () => {
  h.apps
    .mockReset()
    .mockResolvedValue([
      { whatsapp_business_api_data: { id: '1444327167651307' } },
    ]);
  fetcher
    .mockReset()
    .mockResolvedValue(response({ id: '456', status: 'PENDING' }));
  await expect(
    activateSignup(context, 'token', { registrationRequested: true })
  ).rejects.toThrow('unconfirmed outcome');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(h.subscribe).not.toHaveBeenCalled();
});
it('revalidates saved credentials without OAuth exchange', async () => {
  fetcher
    .mockReset()
    .mockResolvedValueOnce(response({ data: validDebug }))
    .mockResolvedValueOnce(response({ id: '123', name: 'Customer' }));
  await validateSignupToken('saved-token', context);
  expect(
    fetcher.mock.calls.some((call) =>
      String(call[0]).includes('oauth/access_token')
    )
  ).toBe(false);
});

it('stale workers cannot subscribe after the lease guard fails', async () => {
  guard.mockRejectedValueOnce(new Error('stale lease'));
  await expect(activateSignup(context, 'token')).rejects.toThrow('stale lease');
  expect(h.subscribe).not.toHaveBeenCalled();
});
it('stale workers cannot POST registration after recording intent', async () => {
  h.apps
    .mockReset()
    .mockResolvedValue([
      { whatsapp_business_api_data: { id: '1444327167651307' } },
    ]);
  fetcher
    .mockReset()
    .mockResolvedValue(response({ id: '456', status: 'PENDING' }));
  const activation = await activateSignup(context, 'token');
  if (!activation.needsRegistration) throw new Error();
  guard.mockRejectedValueOnce(new Error('stale lease'));
  await expect(activation.register()).rejects.toThrow('stale lease');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('verifies both Meta states in the final read-only barrier', async () => {
  h.apps
    .mockReset()
    .mockResolvedValue([
      { whatsapp_business_api_data: { id: '1444327167651307' } },
    ]);
  fetcher
    .mockReset()
    .mockResolvedValue(response({ id: '456', status: 'CONNECTED' }));
  expect(await verifySignupActivation(context, 'token')).toEqual({
    registeredAt: expect.any(String),
    subscribedAt: expect.any(String),
  });
  expect(h.subscribe).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0][1]?.method).not.toBe('POST');
});
it.each(['subscription', 'registration'])(
  'blocks finalization when final %s verification fails',
  async (failing) => {
    h.apps
      .mockReset()
      .mockResolvedValue(
        failing === 'subscription'
          ? []
          : [{ whatsapp_business_api_data: { id: '1444327167651307' } }]
      );
    fetcher
      .mockReset()
      .mockResolvedValue(response({ id: '456', status: 'PENDING' }));
    await expect(verifySignupActivation(context, 'token')).rejects.toThrow(
      'not verified'
    );
    expect(h.subscribe).not.toHaveBeenCalled();
  }
);

it('captures WABA-only Coexistence completion without dropping the event', () => {
  expect(
    signupEvent('https://www.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      data: { waba_id: '123' },
      version: 3,
    })
  ).toEqual({
    event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    context: { waba_id: '123' },
  });
});
it('Coexistence skips registration even when status is not CONNECTED', async () => {
  fetcher.mockReset().mockResolvedValue(
    response({
      id: '456',
      status: 'PENDING',
      is_on_biz_app: true,
      platform_type: 'CLOUD_API',
    })
  );
  const result = await activateWithLease(
    context,
    'token',
    undefined,
    guard,
    'coexistence'
  );
  expect(result.needsRegistration).toBe(false);
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(
    true
  );
});
it.each([
  { is_on_biz_app: false, platform_type: 'CLOUD_API' },
  { is_on_biz_app: true, platform_type: 'ON_PREMISE' },
  {},
])('blocks unverified Coexistence without registration %j', async (state) => {
  fetcher.mockReset().mockResolvedValue(response({ id: '456', ...state }));
  await expect(
    activateWithLease(context, 'token', undefined, guard, 'coexistence')
  ).rejects.toThrow('not confirmed');
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(
    true
  );
});
it('standard launch detects phone-number-first Coexistence and never registers', async () => {
  fetcher.mockReset().mockImplementation(async () =>
    response({
      id: '456',
      status: 'PENDING',
      is_on_biz_app: true,
      platform_type: 'CLOUD_API',
    })
  );
  expect(await activateSignup(context, 'token')).toMatchObject({
    needsRegistration: false,
    mode: 'coexistence',
  });
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(
    true
  );
});
it('resolves the sole authorized phone for WABA-only Coexistence completion', async () => {
  fetcher
    .mockReset()
    .mockResolvedValueOnce(response({ data: validDebug }))
    .mockResolvedValueOnce(response({ id: '123', name: 'Customer' }))
    .mockResolvedValueOnce(
      response({ id: '456', is_on_biz_app: true, platform_type: 'CLOUD_API' })
    );
  expect(
    (await validateSignupToken('token', { waba_id: '123' }, 'coexistence'))
      .context
  ).toEqual(context);
});
it('does not guess a phone when two authorized Coexistence numbers exist', async () => {
  h.numbers.mockResolvedValue([
    { id: '456', display_phone_number: '+123' },
    { id: '789', display_phone_number: '+456' },
  ]);
  fetcher
    .mockReset()
    .mockResolvedValueOnce(response({ data: validDebug }))
    .mockResolvedValueOnce(response({ id: '123' }))
    .mockImplementation(async () =>
      response({ is_on_biz_app: true, platform_type: 'CLOUD_API' })
    );
  await expect(
    validateSignupToken('token', { waba_id: '123' }, 'coexistence')
  ).rejects.toThrow('one eligible');
});

it('shows Meta eligibility details without exposing OAuth credentials or raw messages', async () => {
  fetcher.mockReset().mockResolvedValue(
    response(
      {
        error: {
          code: 100,
          error_subcode: 2494064,
          fbtrace_id: 'trace_safe-123',
          message: 'raw private-token',
          error_user_msg:
            'This number is ineligible: private-code test-meta-app-secret',
        },
      },
      400
    )
  );
  const failure = await exchangeSignupCode('private-code', context).catch(
    (error) => error
  );
  expect(failure.message).toContain('This number is ineligible');
  expect(failure.message).toContain('2494064');
  expect(failure.message).not.toContain('private-code');
  expect(failure.message).not.toContain('private-token');
  expect(failure.message).not.toContain('test-meta-app-secret');
  expect(failure.meta).toEqual({
    code: 100,
    subcode: 2494064,
    fbtrace_id: 'trace_safe-123',
  });
});

it('retains an unfamiliar numeric Meta signup error without inventing its cause', () => {
  expect(signupEligibilityError(123456)).toContain('(123456)');
});
