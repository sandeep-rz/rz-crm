import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  type RukiyeZaraSsoDependencies,
  type RukiyeZaraSsoExchange,
  RukiyeZaraSsoError,
  SupabaseRukiyeZaraSsoDependencies,
  establishRukiyeZaraSsoSession,
  exchangeRukiyeZaraSsoCode,
} from './rukiye-zara-sso';

const EXTERNAL_USER_ID = '11111111-1111-4111-8111-111111111111';
const CRM_USER_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const CODE = 'single-use-pms-code';
const API_SECRET = 'pms-api-secret-never-log';
const TOKEN_HASH = 'internal-magic-link-token-never-log';

const EXCHANGE: RukiyeZaraSsoExchange = {
  provider: 'rukiye_zara',
  user: {
    external_user_id: EXTERNAL_USER_ID,
    email: 'untrusted-pms-email@example.com',
    display_name: 'PMS Owner',
    host_id: 74115,
  },
  property_id: '22008',
  metadata: {
    property_app_connection_id: 'connection-1',
    crm_workspace_id: WORKSPACE_ID,
  },
};

function successfulExchangeBody() {
  return {
    ok: true,
    provider: 'rukiye_zara',
    user: EXCHANGE.user,
    property_id: 22008,
    metadata: EXCHANGE.metadata,
  };
}

function dependencies(
  overrides: Partial<RukiyeZaraSsoDependencies> = {}
): RukiyeZaraSsoDependencies {
  return {
    exchangeCode: vi.fn().mockResolvedValue(EXCHANGE),
    findMappedUserId: vi.fn().mockResolvedValue(CRM_USER_ID),
    getAuthUser: vi.fn().mockResolvedValue({
      id: CRM_USER_ID,
      email: 'verified-crm-user@example.com',
      emailVerified: true,
    }),
    findPropertyMappings: vi.fn().mockResolvedValue([
      {
        accountId: WORKSPACE_ID,
        integrationId: 'integration-1',
        propertyId: 'property-1',
      },
    ]),
    hasMembership: vi.fn().mockResolvedValue(true),
    generateLoginToken: vi.fn().mockResolvedValue(TOKEN_HASH),
    verifyLoginToken: vi.fn().mockResolvedValue(CRM_USER_ID),
    switchAccount: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  process.env.RZ_PMS_SSO_EXCHANGE_URL =
    'https://pms.example.test/functions/v1/rz-crm-sso/exchange';
  process.env.RZ_PMS_API_KEY_ID = 'key-id-1';
  process.env.RZ_PMS_API_SECRET = API_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RZ_PMS_SSO_EXCHANGE_URL;
  delete process.env.RZ_PMS_API_KEY_ID;
  delete process.env.RZ_PMS_API_SECRET;
});

describe('Rukiye Zara PMS SSO exchange', () => {
  it('authenticates the exchange and validates its response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successfulExchangeBody()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await exchangeRukiyeZaraSsoCode(CODE, fetchImpl);

    expect(result.property_id).toBe('22008');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(process.env.RZ_PMS_SSO_EXCHANGE_URL);
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_SECRET}`,
        'X-RZ-Key-Id': 'key-id-1',
      },
      body: JSON.stringify({ code: CODE }),
      cache: 'no-store',
    });
  });

  it.each([
    ['invalid or expired code', 400],
    ['exchange authentication failure', 401],
  ])('maps %s to a safe exchange failure', async (_label, status) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('sensitive upstream detail', { status }));

    await expect(
      exchangeRukiyeZaraSsoCode(CODE, fetchImpl)
    ).rejects.toMatchObject({ code: 'exchange_failed' });
  });

  it('does not retry a reused one-time code', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('already consumed', { status: 409 }));

    await expect(
      exchangeRukiyeZaraSsoCode(CODE, fetchImpl)
    ).rejects.toMatchObject({ code: 'exchange_failed' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not expose the code, secret, response, or token in errors or logs', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        new Error(`${CODE}:${API_SECRET}:${TOKEN_HASH}:upstream-private-error`)
      );

    let thrown: unknown;
    try {
      await exchangeRukiyeZaraSsoCode(CODE, fetchImpl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RukiyeZaraSsoError);
    expect(String((thrown as Error).message)).toBe('exchange_failed');
    expect(
      JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])
    ).not.toContain(CODE);
    expect(
      JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])
    ).not.toContain(API_SECRET);
    expect(
      JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])
    ).not.toContain(TOKEN_HASH);
  });
});

describe('Rukiye Zara PMS SSO identity and session bootstrap', () => {
  it('fails when the durable external identity mapping is missing', async () => {
    const deps = dependencies({
      findMappedUserId: vi.fn().mockResolvedValue(null),
    });

    await expect(
      establishRukiyeZaraSsoSession(CODE, deps)
    ).rejects.toMatchObject({ code: 'identity_not_found' });
    expect(deps.generateLoginToken).not.toHaveBeenCalled();
  });

  it('does not resolve a different external_user_id by email', async () => {
    const findMappedUserId = vi
      .fn()
      .mockImplementation((externalUserId) =>
        externalUserId === EXTERNAL_USER_ID ? CRM_USER_ID : null
      );
    const deps = dependencies({
      exchangeCode: vi.fn().mockResolvedValue({
        ...EXCHANGE,
        user: {
          ...EXCHANGE.user,
          external_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          email: 'verified-crm-user@example.com',
        },
      }),
      findMappedUserId,
    });

    await expect(
      establishRukiyeZaraSsoSession(CODE, deps)
    ).rejects.toMatchObject({ code: 'identity_not_found' });
    expect(findMappedUserId).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
  });

  it('fails when the mapped Supabase Auth user is missing', async () => {
    const deps = dependencies({
      getAuthUser: vi.fn().mockResolvedValue(null),
    });

    await expect(
      establishRukiyeZaraSsoSession(CODE, deps)
    ).rejects.toMatchObject({ code: 'mapped_user_missing' });
  });

  it('rejects a workspace membership mismatch', async () => {
    const deps = dependencies({
      hasMembership: vi.fn().mockResolvedValue(false),
    });

    await expect(
      establishRukiyeZaraSsoSession(CODE, deps)
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    expect(deps.generateLoginToken).not.toHaveBeenCalled();
  });

  it('rejects a PMS property that is not mapped to the expected workspace', async () => {
    const deps = dependencies({
      findPropertyMappings: vi.fn().mockResolvedValue([
        {
          accountId: OTHER_WORKSPACE_ID,
          integrationId: 'integration-2',
          propertyId: 'property-2',
        },
      ]),
    });

    await expect(
      establishRukiyeZaraSsoSession(CODE, deps)
    ).rejects.toMatchObject({ code: 'property_mapping_invalid' });
    expect(deps.hasMembership).not.toHaveBeenCalled();
  });

  it('creates a standard session for the mapped user and switches workspace', async () => {
    const deps = dependencies();

    const result = await establishRukiyeZaraSsoSession(CODE, deps);

    expect(result).toEqual({
      userId: CRM_USER_ID,
      accountId: WORKSPACE_ID,
    });
    expect(deps.findMappedUserId).toHaveBeenCalledWith(EXTERNAL_USER_ID);
    expect(deps.generateLoginToken).toHaveBeenCalledWith({
      id: CRM_USER_ID,
      email: 'verified-crm-user@example.com',
      emailVerified: true,
    });
    expect(deps.verifyLoginToken).toHaveBeenCalledWith(TOKEN_HASH);
    expect(deps.switchAccount).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(deps.clearSession).not.toHaveBeenCalled();
  });

  it('uses the supported Supabase admin-link and SSR session APIs', async () => {
    const generateLink = vi.fn().mockResolvedValue({
      data: {
        user: { id: CRM_USER_ID },
        properties: { hashed_token: TOKEN_HASH },
      },
      error: null,
    });
    const verifyOtp = vi.fn().mockResolvedValue({
      data: {
        user: { id: CRM_USER_ID },
        session: { access_token: 'not-logged', refresh_token: 'not-logged' },
      },
      error: null,
    });
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: CRM_USER_ID } },
      error: null,
    });
    const rpc = vi.fn().mockResolvedValue({ data: WORKSPACE_ID, error: null });
    const admin = {
      auth: { admin: { generateLink } },
    } as unknown as SupabaseClient;
    const session = {
      auth: { verifyOtp, getUser, signOut: vi.fn() },
      rpc,
    } as unknown as SupabaseClient;
    const supabase = new SupabaseRukiyeZaraSsoDependencies(admin, session);
    const crmUser = {
      id: CRM_USER_ID,
      email: 'verified-crm-user@example.com',
      emailVerified: true,
    };

    const token = await supabase.generateLoginToken(crmUser);
    const sessionUserId = await supabase.verifyLoginToken(token);
    await supabase.switchAccount(WORKSPACE_ID);

    expect(generateLink).toHaveBeenCalledWith({
      type: 'magiclink',
      email: crmUser.email,
    });
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: TOKEN_HASH,
      type: 'magiclink',
    });
    expect(getUser).toHaveBeenCalledOnce();
    expect(sessionUserId).toBe(CRM_USER_ID);
    expect(rpc).toHaveBeenCalledWith('switch_account', {
      p_account_id: WORKSPACE_ID,
    });
  });

  it('clears a session that authenticates as any user except the mapped user', async () => {
    const deps = dependencies({
      verifyLoginToken: vi.fn().mockResolvedValue('wrong-user-id'),
    });

    await expect(
      establishRukiyeZaraSsoSession(CODE, deps)
    ).rejects.toMatchObject({ code: 'session_failed' });
    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.switchAccount).not.toHaveBeenCalled();
  });
});
