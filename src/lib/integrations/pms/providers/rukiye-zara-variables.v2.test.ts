import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { PmsHttpClient } from '../http-client';
import { RukiyeZaraVariableResolver } from './rukiye-zara-variables';
import type { ConnectedVariableContext } from '../variable-resolver';

const context: ConnectedVariableContext = {
  accountId: '00000000-0000-4000-8000-000000000001',
  integrationId: '00000000-0000-4000-8000-000000000002',
  provider: 'rukiye_zara',
  externalAccountId: 'host-123',
  externalPropertyId: '456',
  externalReservationId: '00000000-0000-4000-8000-000000000003',
  sourceType: 'pms_bookings',
};

const expectedContext = {
  source_type: 'pms_booking',
  source_record_id: context.externalReservationId,
  external_account_id: 'host-123',
  external_property_id: '456',
};

function makeResolver(fetchImpl: typeof fetch) {
  return new RukiyeZaraVariableResolver(new PmsHttpClient({
    baseUrl: 'https://pms.example',
    keyId: 'service-key',
    secret: 'server-secret',
    fetchImpl,
  }));
}

describe('RZ-PMS capability contract v2', () => {
  it('does not call v2 for legacy variables', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toEndWith('/variables/resolve');
      const body = JSON.parse(init!.body as string);
      expect(body.contract_version).toBe('v1');
      return new Response(JSON.stringify({
        success: true,
        contract_version: 'v1',
        context: body.context,
        values: { 'contact.first_name': { status: 'resolved', value: 'Guest' } },
      }));
    });
    expect(await makeResolver(fetchImpl).resolveVariables({
      context, variableKeys: ['contact.first_name'],
    })).toEqual({ 'contact.first_name': { status: 'resolved', value: 'Guest' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves digital check-in and preserves property disabled reason', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toEndWith('/capabilities/resolve');
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({
        contract_version: 'v2',
        context: expectedContext,
        capabilities: ['reservation.digital_checkin_url', 'reservation.review_url'],
      });
      return new Response(JSON.stringify({
        success: true,
        contract_version: 'v2',
        context: expectedContext,
        values: {
          'reservation.digital_checkin_url': {
            status: 'missing',
            value: null,
            reason: 'feature_disabled',
          },
          'reservation.review_url': {
            status: 'unsupported', value: null, reason: 'provider_unsupported',
          },
        },
      }));
    });
    expect(await makeResolver(fetchImpl).resolveVariables({
      context,
      variableKeys: ['reservation.digital_checkin_url', 'reservation.review_url'],
    })).toEqual({
      'reservation.digital_checkin_url': {
        status: 'missing', value: null, reason: 'feature_disabled',
      },
      'reservation.review_url': {
        status: 'unsupported', value: null, reason: 'provider_unsupported',
      },
    });
  });

  it('rejects another property or account in the provider response', async () => {
    for (const field of ['external_account_id', 'external_property_id']) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({
          success: true,
          contract_version: 'v2',
          context: { ...expectedContext, [field]: 'forged' },
          values: {
            'reservation.digital_checkin_url': {
              status: 'resolved',
              value: 'https://checkin.example/c/token',
            },
          },
        }))
      );
      await expect(makeResolver(fetchImpl).resolveVariables({
        context, variableKeys: ['reservation.digital_checkin_url'],
      })).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('rejects unsafe links and does not log bearer tokens', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        contract_version: 'v2',
        context: expectedContext,
        values: {
          'reservation.digital_checkin_url': {
            status: 'resolved',
            value: 'javascript:private-token',
          },
        },
      }))
    );
    const log = vi.spyOn(console, 'log');
    await expect(makeResolver(fetchImpl).resolveVariables({
      context, variableKeys: ['reservation.digital_checkin_url'],
    })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('allows mixed v1/v2 resolution without losing either result', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith('/capabilities/resolve')) {
        return new Response(JSON.stringify({
          success: true,
          contract_version: 'v2',
          context: expectedContext,
          values: {
            'reservation.digital_checkin_url': {
              status: 'resolved',
              value: 'https://checkin.example/c/private-token',
            },
          },
        }));
      }
      const body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({
        success: true,
        contract_version: 'v1',
        context: body.context,
        values: { 'contact.first_name': { status: 'resolved', value: 'Guest' } },
      }));
    });
    expect(await makeResolver(fetchImpl).resolveVariables({
      context, variableKeys: ['contact.first_name', 'reservation.digital_checkin_url'],
    })).toEqual({
      'contact.first_name': { status: 'resolved', value: 'Guest' },
      'reservation.digital_checkin_url': {
        status: 'resolved', value: 'https://checkin.example/c/private-token',
      },
    });
    expect(urls).toHaveLength(2);
  });
});
