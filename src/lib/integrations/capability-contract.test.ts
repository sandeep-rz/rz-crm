import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_CAPABILITIES,
  normalizeUrlCapability,
  scopeCapabilityRoute,
  type TrustedIntegrationBinding,
} from './capability-contract';

const binding: TrustedIntegrationBinding = {
  accountId: 'workspace-1',
  integrationId: 'integration-1',
  provider: 'rukiye_zara',
  externalAccountId: 'external-account',
  configVersion: 1,
  properties: [
    { crmPropertyId: 'property-a', externalPropertyId: '123', enabled: true },
    { crmPropertyId: 'property-b', externalPropertyId: '456', enabled: false },
  ],
};

describe('integration capability vocabulary', () => {
  it('declares both URLs as provider-independent reservation variables', () => {
    expect(INTEGRATION_CAPABILITIES['reservation.digital_checkin_url']).toMatchObject({
      kind: 'variable',
      scope: 'reservation',
      dataType: 'url',
    });
    expect(INTEGRATION_CAPABILITIES['reservation.review_url'].kind).toBe('variable');
    expect(INTEGRATION_CAPABILITIES['availability.search'].kind).toBe('query');
    expect(INTEGRATION_CAPABILITIES['reservation.cancel'].kind).toBe('action');
    expect(INTEGRATION_CAPABILITIES['review.submitted'].kind).toBe('event');
  });
  it('rejects malformed and non-https URLs without leaking them', () => {
    for (const value of ['not-a-url', '', 'http://example.com/x', 'javascript:alert(1)', 'https://user:pass@example.com']) {
      expect(normalizeUrlCapability('reservation.digital_checkin_url', {
        status: 'resolved',
        value,
      })).toEqual({
        capability: 'reservation.digital_checkin_url',
        status: 'unavailable',
        reason: 'unavailable',
      });
    }
  });
  it('returns a valid HTTPS check-in link without changing its token', () => {
    const url = 'https://checkin.example.com/c/secret-token';
    expect(normalizeUrlCapability('reservation.digital_checkin_url', {
      status: 'resolved',
      value: url,
    })).toEqual({
      capability: 'reservation.digital_checkin_url',
      status: 'available',
      value: url,
    });
  });
  it('distinguishes disabled property and link not ready', () => {
    expect(normalizeUrlCapability('reservation.digital_checkin_url', {
      status: 'missing',
      value: null,
      reason: 'feature_disabled',
    }).reason).toBe('feature_disabled');
    expect(normalizeUrlCapability('reservation.digital_checkin_url', {
      status: 'missing',
      value: null,
      reason: 'not_ready',
    }).reason).toBe('not_ready');
  });
});

describe('trusted integration routing', () => {
  it('translates only allowed CRM property IDs to externally mapped properties', () => {
    expect(scopeCapabilityRoute(binding, ['property-a', 'property-a'])).toEqual({
      ok: true,
      accountId: 'workspace-1',
      integrationId: 'integration-1',
      provider: 'rukiye_zara',
      externalAccountId: 'external-account',
      crmPropertyIds: ['property-a'],
      externalPropertyIds: ['123'],
      configVersion: 1,
    });
  });
  it('fails closed when properties are disabled, unknown, or omitted', () => {
    for (const ids of [[], ['property-b'], ['unknown'], ['property-a', 'property-b']]) {
      expect(scopeCapabilityRoute(binding, ids)).toEqual({
        ok: false,
        reason: 'property_out_of_scope',
      });
    }
  });
  it('rejects malformed bindings and ambiguous mappings', () => {
    expect(scopeCapabilityRoute({ ...binding, configVersion: 0 }, ['property-a'])).toEqual({
      ok: false,
      reason: 'invalid_binding',
    });
    expect(scopeCapabilityRoute({
      ...binding,
      properties: [...binding.properties, binding.properties[0]],
    }, ['property-a'])).toEqual({
      ok: false,
      reason: 'invalid_binding',
    });
  });
});
