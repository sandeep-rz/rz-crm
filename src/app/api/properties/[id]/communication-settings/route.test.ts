import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
  getSettings: vi.fn(),
  upsertSettings: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: mocks.toErrorResponse,
}));

vi.mock('@/lib/properties/communication-settings', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/properties/communication-settings')
  >('@/lib/properties/communication-settings');
  return {
    ...actual,
    getPropertyCommunicationSettings: mocks.getSettings,
    upsertPropertyCommunicationSettings: mocks.upsertSettings,
  };
});

import { PropertyCommunicationSettingsError } from '@/lib/properties/communication-settings';
import { GET, PATCH } from './route';

const db = { name: 'rls-client' };
const account = {
  accountId: 'account-a',
  userId: 'user-a',
  role: 'admin',
  supabase: db,
};
const routeContext = { params: Promise.resolve({ id: 'property-a' }) };

describe('property communication settings route', () => {
  beforeEach(() => {
    mocks.getCurrentAccount.mockReset().mockResolvedValue(account);
    mocks.requireRole.mockReset().mockResolvedValue(account);
    mocks.toErrorResponse.mockClear();
    mocks.getSettings.mockReset().mockResolvedValue({
      id: null,
      account_id: 'account-a',
      pms_property_id: 'property-a',
      map_url: null,
    });
    mocks.upsertSettings.mockReset().mockResolvedValue({
      id: 'settings-a',
      account_id: 'account-a',
      pms_property_id: 'property-a',
      map_url: 'https://maps.example/a',
    });
  });

  it('lets a workspace member read only through the active account and property id', async () => {
    const response = await GET(
      new Request(
        'http://localhost/api/properties/property-a/communication-settings'
      ),
      routeContext
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.getCurrentAccount).toHaveBeenCalledOnce();
    expect(mocks.getSettings).toHaveBeenCalledWith({
      accountId: 'account-a',
      pmsPropertyId: 'property-a',
      db,
    });
  });

  it('requires the existing admin settings role for create/update/clear', async () => {
    const response = await PATCH(
      new Request(
        'http://localhost/api/properties/property-a/communication-settings',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ wifi_password: '' }),
        }
      ),
      routeContext
    );
    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.upsertSettings).toHaveBeenCalledWith({
      accountId: 'account-a',
      pmsPropertyId: 'property-a',
      values: { wifi_password: '' },
      db,
    });
  });

  it('returns not found when a property is outside the active workspace', async () => {
    mocks.getSettings.mockRejectedValueOnce(
      new PropertyCommunicationSettingsError(
        'property_not_found',
        'Property not found in this workspace.'
      )
    );
    const response = await GET(
      new Request(
        'http://localhost/api/properties/property-c/communication-settings'
      ),
      { params: Promise.resolve({ id: 'property-c' }) }
    );
    expect(response.status).toBe(404);
  });

  it('does not invoke the service when the caller lacks the write role', async () => {
    mocks.requireRole.mockRejectedValueOnce(new Error('forbidden'));
    const response = await PATCH(
      new Request(
        'http://localhost/api/properties/property-a/communication-settings',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ map_url: 'https://maps.example/a' }),
        }
      ),
      routeContext
    );
    expect(response.status).toBe(403);
    expect(mocks.upsertSettings).not.toHaveBeenCalled();
  });
});
