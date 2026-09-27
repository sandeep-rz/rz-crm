import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  provision: vi.fn(),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

vi.mock('@/lib/integrations/pms/provisioning', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/integrations/pms/provisioning')
    >();
  return { ...actual, provisionRukiyeZara: h.provision };
});

import { POST } from './route';

const KEY_ID = '4c621815-f779-4011-b954-60c82941c09b';
const RAW_SECRET = 'rz-pms-test-secret-never-log-this';
const BODY = {
  installation_id: '11111111-1111-4111-8111-111111111111',
  external_account_id: 'host-74115',
  owner: {
    external_user_id: 'rz-user-9',
    email: 'Owner@Example.com',
    display_name: 'Owner Name',
  },
  property: {
    external_property_id: '22008',
    name: 'Lakeside Meadows',
  },
};

function request(
  body: unknown = BODY,
  headers: Record<string, string> = {
    Authorization: `Bearer ${RAW_SECRET}`,
    'X-PMS-Key-Id': KEY_ID,
    'Content-Type': 'application/json',
  }
) {
  return new Request(
    'http://localhost/api/integrations/rukiye-zara/provision',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  h.rpc.mockResolvedValue({
    data: [
      {
        credential_id: '22222222-2222-4222-8222-222222222222',
        provider: 'rukiye_zara',
        scopes: ['provision'],
      },
    ],
    error: null,
  });
  h.provision.mockResolvedValue({
    ok: true,
    provider: 'rukiye_zara',
    workspace_id: '33333333-3333-4333-8333-333333333333',
    integration_id: '44444444-4444-4444-8444-444444444444',
    crm_property_id: '55555555-5555-4555-8555-555555555555',
    external_account_id: BODY.external_account_id,
    external_property_id: BODY.property.external_property_id,
    initial_sync_status: 'pending',
  });
});

describe('POST /api/integrations/rukiye-zara/provision', () => {
  it('returns 401 when provider credentials are missing', async () => {
    const response = await POST(
      request(BODY, { 'Content-Type': 'application/json' })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'invalid_provider_credentials',
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('returns 401 when provider credentials do not verify', async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'invalid_provider_credentials',
    });
    expect(h.provision).not.toHaveBeenCalled();
  });

  it('returns 403 when the credential belongs to another provider', async () => {
    h.rpc.mockResolvedValue({
      data: [
        {
          credential_id: '22222222-2222-4222-8222-222222222222',
          provider: 'another_provider',
          scopes: ['provision'],
        },
      ],
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'provider_not_allowed',
    });
    expect(h.provision).not.toHaveBeenCalled();
  });

  it('hashes the secret and rejects malformed or privilege-bearing payloads', async () => {
    const response = await POST(
      request({ ...BODY, workspace_id: 'attacker-choice' })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(h.rpc).toHaveBeenCalledWith('verify_pms_provider_credential', {
      p_key_id: KEY_ID,
      p_secret_hash: createHash('sha256').update(RAW_SECRET).digest('hex'),
      p_required_scope: 'provision',
    });
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain(RAW_SECRET);
    expect(h.provision).not.toHaveBeenCalled();
  });

  it('normalizes the email and returns the stable provisioning response', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(h.provision).toHaveBeenCalledWith({
      ...BODY,
      owner: { ...BODY.owner, email: 'owner@example.com' },
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      workspace_id: '33333333-3333-4333-8333-333333333333',
      integration_id: '44444444-4444-4444-8444-444444444444',
      crm_property_id: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('never returns or logs the raw provider secret', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    h.provision.mockRejectedValue(new Error(`sensitive ${RAW_SECRET}`));

    const response = await POST(request());
    const responseText = await response.text();
    const logged = JSON.stringify(consoleError.mock.calls);

    expect(response.status).toBe(500);
    expect(responseText).not.toContain(RAW_SECRET);
    expect(logged).not.toContain(RAW_SECRET);
    expect(responseText).not.toContain('sensitive');
  });
});
