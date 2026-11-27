import { createPmsProvider } from '@/lib/integrations/pms/registry';
import type { PmsProvider } from '@/lib/integrations/pms/provider';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import type { ReservationAutomationContext } from './pms-context';

// Keep native booker identity semantics unchanged. For shared PMS guests,
// verify authoritative contact data before sending; webhook lag/conflicts
// must not cause a send to a superseded number.
export async function isCurrentPmsGuestRecipient(
  context: ReservationAutomationContext,
  normalizedPhone: string,
  makeProvider: (name: string) => PmsProvider = createPmsProvider
): Promise<boolean> {
  if (context.source_type !== 'pms_reservations' && context.source_type !== 'pms_bookings')
    return true;
  if (!context.external_guest_id || !context.external_property_id || !context.external_account_id)
    return false;
  const provider = makeProvider(context.provider);
  if (!provider.getGuest) return false;
  const guest = await provider.getGuest({
    integration: {
      integrationId: context.pms_integration_id,
      accountId: context.account_id,
      provider: context.provider,
      externalAccountId: context.external_account_id,
    },
    externalPropertyId: context.external_property_id,
    externalGuestId: context.external_guest_id,
  });
  if (guest.externalId !== context.external_guest_id ||
      guest.externalPropertyId !== context.external_property_id ||
      guest.clearedFields.includes('phone')) return false;
  // An unavailable/unqualified PMS phone cannot certify a recipient.
  const phone = guest.phone ? parseInternationalPhone(guest.phone) : null;
  return phone !== null && phone === normalizedPhone;
}
