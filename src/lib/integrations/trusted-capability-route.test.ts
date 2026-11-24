import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));
import { loadTrustedCapabilityRoute } from './trusted-capability-route';

const accountId = '00000000-0000-4000-8000-000000000001';
const integrationId = '00000000-0000-4000-8000-000000000002';
const propertyId = '00000000-0000-4000-8000-000000000003';

function fakeDb(overrides: {
  integration?: Record<string, unknown> | null;
  properties?: Record<string, unknown>[];
} = {}) {
  const reads: string[] = [];
  const integration = overrides.integration === undefined
    ? {
        id: integrationId, account_id: accountId, provider: 'rukiye_zara',
        external_account_id: 'external-host', status: 'connected',
        capability_config_version: 2,
      }
    : overrides.integration;
  const properties = overrides.properties ?? [
    { id: propertyId, account_id: accountId,
      pms_integration_id: integrationId, external_property_id: '123', status: 'active' },
  ];
  const db = {
    from(table: string) {
      reads.push(table);
      const query = {
        select: () => query,
        eq: () => query,
        in: () => Promise.resolve({ data: properties, error: null }),
        maybeSingle: () => Promise.resolve({ data: integration, error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { db, reads };
}

describe('trusted capability route from CRM', () => {
  it('accepts only mapped, connected properties', async () => {
    const { db } = fakeDb();
    expect(await loadTrustedCapabilityRoute({
      accountId, integrationId, crmPropertyIds: [propertyId],
    }, db)).toEqual({
      ok: true,
      accountId,
      integrationId,
      provider: 'rukiye_zara',
      externalAccountId: 'external-host',
      crmPropertyIds: [propertyId],
      externalPropertyIds: ['123'],
      configVersion: 2,
    });
  });

  it('rejects disconnected integrations without loading property data', async () => {
    const { db, reads } = fakeDb({
      integration: {
        id: integrationId, account_id: accountId, status: 'disconnected',
      },
    });
    expect(await loadTrustedCapabilityRoute({
      accountId, integrationId, crmPropertyIds: [propertyId],
    }, db)).toEqual({ ok: false, reason: 'invalid_binding' });
    expect(reads).toEqual(['pms_integrations']);
  });

  it('does not accept a cross-account integration row even if the query returned it', async () => {
    const { db } = fakeDb({
      integration: {
        id: integrationId,
        account_id: '00000000-0000-4000-8000-000000000099',
        provider: 'rukiye_zara', external_account_id: 'host',
        status: 'connected', capability_config_version: 1,
      },
    });
    expect(await loadTrustedCapabilityRoute({
      accountId, integrationId, crmPropertyIds: [propertyId],
    }, db)).toEqual({ ok: false, reason: 'invalid_binding' });
  });

  it('rejects missing/disabled/cross-integration properties', async () => {
    for (const properties of [
      [],
      [{ id: propertyId, account_id: accountId,
         pms_integration_id: integrationId, external_property_id: '123', status: 'inactive' }],
      [{ id: propertyId, account_id: accountId,
         pms_integration_id: '00000000-0000-4000-8000-000000000099',
         external_property_id: '123', status: 'active' }],
    ]) {
      const { db } = fakeDb({ properties });
      expect(await loadTrustedCapabilityRoute({
        accountId, integrationId, crmPropertyIds: [propertyId],
      }, db)).toEqual({ ok: false, reason: 'property_out_of_scope' });
    }
  });

  it('does not query the database for forged identifiers', async () => {
    const { db, reads } = fakeDb();
    expect(await loadTrustedCapabilityRoute({
      accountId, integrationId, crmPropertyIds: ['untrusted-property'],
    }, db)).toEqual({ ok: false, reason: 'invalid_binding' });
    expect(reads).toHaveLength(0);
  });
});
