import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  establishSession: vi.fn(),
}));

vi.mock('@/lib/integrations/pms/rukiye-zara-sso', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/integrations/pms/rukiye-zara-sso')
    >();
  return {
    ...actual,
    establishRukiyeZaraSsoSession: h.establishSession,
  };
});

import { RukiyeZaraSsoError } from '@/lib/integrations/pms/rukiye-zara-sso';

import { GET } from './route';

const CODE = 'one-time-pms-code-never-log';
const TOKEN = 'supabase-token-never-log';
const SECRET = 'pms-api-secret-never-log';

function request(query = '') {
  return new Request(
    `https://crm.example.test/auth/rukiye-zara/callback${query}`
  );
}

beforeEach(() => {
  h.establishSession.mockResolvedValue({
    userId: 'user-1',
    accountId: 'account-1',
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('GET /auth/rukiye-zara/callback', () => {
  it('redirects a missing code to a safe login error', async () => {
    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://crm.example.test/login?sso_error=missing_code'
    );
    expect(h.establishSession).not.toHaveBeenCalled();
  });

  it('rejects an excessively long code without processing it', async () => {
    const response = await GET(request(`?code=${'x'.repeat(4097)}`));

    expect(response.headers.get('location')).toContain(
      '/login?sso_error=missing_code'
    );
    expect(h.establishSession).not.toHaveBeenCalled();
  });

  it.each([
    'exchange_failed',
    'identity_not_found',
    'mapped_user_missing',
    'workspace_access_denied',
    'property_mapping_invalid',
    'session_failed',
  ] as const)('redirects %s using only the safe error code', async (code) => {
    h.establishSession.mockRejectedValue(new RukiyeZaraSsoError(code));

    const response = await GET(request(`?code=${CODE}`));

    expect(response.headers.get('location')).toBe(
      `https://crm.example.test/login?sso_error=${code}`
    );
  });

  it('redirects a successful SSO login to the dashboard', async () => {
    const response = await GET(request(`?code=${CODE}`));

    expect(h.establishSession).toHaveBeenCalledWith(CODE);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://crm.example.test/dashboard'
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('does not expose secrets, codes, tokens, or exceptions on failure', async () => {
    h.establishSession.mockRejectedValue(
      new Error(`${CODE}:${SECRET}:${TOKEN}:private-error`)
    );

    const response = await GET(request(`?code=${CODE}`));
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    const location = response.headers.get('location') ?? '';

    expect(location).toBe(
      'https://crm.example.test/login?sso_error=session_failed'
    );
    for (const sensitive of [CODE, SECRET, TOKEN, 'private-error']) {
      expect(logged).not.toContain(sensitive);
      expect(location).not.toContain(sensitive);
    }
  });
});
