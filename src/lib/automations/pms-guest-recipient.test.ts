import { describe, it, expect, vi } from 'vitest';
import { isCurrentPmsGuestRecipient } from './pms-guest-recipient';
import type { ReservationAutomationContext } from './pms-context';
import type { PmsProvider } from '@/lib/integrations/pms/provider';

const context = {
  source_type: 'pms_reservations', external_guest_id: 'guest',
  external_property_id: 'property', external_account_id: 'host',
  account_id: 'account', pms_integration_id: 'integration', provider: 'rukiye_zara',
} as ReservationAutomationContext;
function provider(phone: string | null, clearedFields: Array<'phone'> = [], externalPropertyId = 'property') {
  return () => ({getGuest: vi.fn(async () => ({
    externalId: 'guest', externalPropertyId, phone, clearedFields,
    fullName: null, email: null,
  }))} as unknown as PmsProvider);
}
describe('shared guest recipient guard', () => {
  it('accepts matching authoritative phone', async () => {
    expect(await isCurrentPmsGuestRecipient(context, '919876543210', provider('+919876543210'))).toBe(true);
  });
  it('blocks stale and cleared numbers', async () => {
    expect(await isCurrentPmsGuestRecipient(context, '919876543210', provider('+919876543211'))).toBe(false);
    expect(await isCurrentPmsGuestRecipient(context, '919876543210', provider(null, ['phone']))).toBe(false);
  });
  it('rejects cross-property responses', async () => {
    expect(await isCurrentPmsGuestRecipient(context, '919876543210', provider('+919876543210', [], 'other'))).toBe(false);
  });
  it('does not reinterpret native booker identities', async () => {
    const make = vi.fn(provider(null));
    expect(await isCurrentPmsGuestRecipient({...context, source_type:'bookings'}, '919876543210', make)).toBe(true);
    expect(make).not.toHaveBeenCalled();
  });
});
