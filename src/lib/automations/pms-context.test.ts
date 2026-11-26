import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadReservationAutomationContext } from './pms-context';
function dbFor(propertyStatus = 'active', integrationStatus = 'connected') {
  const rows: Record<string, unknown> = {
    pms_reservations: {
      id: 'r',
      account_id: 'a',
      pms_integration_id: 'i',
      pms_property_id: 'p',
      contact_id: null,
      updated_at: '2026-11-27T00:00:00.000001Z',
      metadata: {
        source_type: 'pms_reservations',
        guest_resolution: 'resolved',
      },
    },
    pms_properties: {
      id: 'p',
      account_id: 'a',
      pms_integration_id: 'i',
      status: propertyStatus,
      timezone: 'UTC',
    },
    pms_integrations: {
      id: 'i',
      account_id: 'a',
      provider: 'rukiye_zara',
      status: integrationStatus,
    },
  };
  return {
    from: (name: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: rows[name], error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}
describe('PMS automation live relationship authorization', () => {
  it('loads a connected active context with full timestamp precision', async () => {
    expect(
      (await loadReservationAutomationContext('r', 'a', dbFor()))
        ?.reservation_updated_at
    ).toBe('2026-11-27T00:00:00.000001Z');
  });
  it.each([
    ['inactive', 'connected'],
    ['active', 'disconnected'],
  ])('rejects %s / %s', async (p, i) => {
    expect(
      await loadReservationAutomationContext('r', 'a', dbFor(p, i))
    ).toBeNull();
  });
});
