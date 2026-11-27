import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import type { PmsIntegrationContext, PmsProvider } from './provider';

export interface GuestSyncContext {
  accountId: string;
  integration: PmsIntegrationContext;
  propertyId: string;
  externalPropertyId: string;
  externalGuestId: string;
  occurredAt: string;
}

export interface LinkedGuestReservation {
  externalId: string;
  sourceType: string;
}

export interface GuestSyncStore {
  findLinkedReservation(input: GuestSyncContext): Promise<LinkedGuestReservation | null>;
  updateMappedContact(input: GuestSyncContext & {
    name: string | null;
    email: string | null;
    phone: string | null;
  }): Promise<boolean>;
}

export class PmsGuestSyncError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_guest' | 'guest_mismatch' | 'storage_error' = 'storage_error'
  ) {
    super(message);
    this.name = 'PmsGuestSyncError';
  }
}

/**
 * Updates only an existing mapped contact. Shared PMS guests use their own
 * property-scoped endpoint; native bookers retain their legacy identity path.
 */
export async function syncPmsGuestContact(
  input: GuestSyncContext,
  provider: PmsProvider,
  store: GuestSyncStore = new SupabaseGuestSyncStore()
): Promise<'updated' | 'unmapped'> {
  if (!input.externalGuestId || !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new PmsGuestSyncError('Invalid guest ID or event time.', 'invalid_guest');
  }
  if (input.accountId !== input.integration.accountId) {
    throw new PmsGuestSyncError('Integration account mismatch.', 'invalid_guest');
  }

  const linked = await store.findLinkedReservation(input);
  if (!linked) return 'unmapped';

  const sharedPms = linked.sourceType === 'pms_reservations' || linked.sourceType === 'pms_bookings';
  let name: string | null;
  let email: string | null;
  let rawPhone: string | null;
  let explicitlyCleared: boolean;
  if (sharedPms && provider.getGuest) {
    const guest = await provider.getGuest({
      integration: input.integration,
      externalPropertyId: input.externalPropertyId,
      externalGuestId: input.externalGuestId,
    });
    if (guest.externalPropertyId !== input.externalPropertyId ||
        guest.externalId !== input.externalGuestId) {
      throw new PmsGuestSyncError('Guest/property mismatch.', 'guest_mismatch');
    }
    name = guest.clearedFields.includes('name') ? null : guest.fullName;
    email = guest.clearedFields.includes('email') ? null : guest.email;
    explicitlyCleared = guest.clearedFields.includes('phone');
    rawPhone = explicitlyCleared ? null : guest.phone;
  } else {
    // Existing providers and native booker mappings retain the legacy lookup.
    const reservation = await provider.getReservation({
      integration: input.integration,
      externalPropertyId: input.externalPropertyId,
      externalReservationId: linked.externalId,
    });
    if (reservation.externalPropertyId !== input.externalPropertyId ||
        reservation.externalId !== linked.externalId ||
        reservation.guest.externalId !== input.externalGuestId) {
      throw new PmsGuestSyncError('Canonical guest/reservation/property mismatch.', 'guest_mismatch');
    }
    name = reservation.guest.fullName;
    email = reservation.guest.email;
    rawPhone = reservation.guest.phone;
    explicitlyCleared = !rawPhone; // preserve the existing legacy contract
  }
  const normalized = rawPhone ? parseInternationalPhone(rawPhone) : null;
  const phone = explicitlyCleared ? '' : normalized ? '+' + normalized : null;
  const updated = await store.updateMappedContact({ ...input, name, email, phone });
  return updated ? 'updated' : 'unmapped';
}

export class SupabaseGuestSyncStore implements GuestSyncStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async findLinkedReservation(input: GuestSyncContext): Promise<LinkedGuestReservation | null> {
    const { data, error } = await this.admin
      .from('pms_reservations')
      .select('external_reservation_id, metadata')
      .eq('account_id', input.accountId)
      .eq('pms_integration_id', input.integration.integrationId)
      .eq('pms_property_id', input.propertyId)
      .eq('external_guest_id', input.externalGuestId)
      .not('contact_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new PmsGuestSyncError('Guest reservation mapping lookup failed.');
    if (!data?.external_reservation_id) return null;
    return { externalId: data.external_reservation_id, sourceType: typeof data.metadata?.source_type === 'string' ? data.metadata.source_type : '' };
  }

  async updateMappedContact(input: GuestSyncContext & {
    name: string | null;
    email: string | null;
    phone: string | null;
  }): Promise<boolean> {
    const { data, error } = await this.admin.rpc('sync_mapped_pms_guest_contact', {
      p_account_id: input.accountId,
      p_integration_id: input.integration.integrationId,
      p_property_id: input.propertyId,
      p_external_guest_id: input.externalGuestId,
      p_event_at: input.occurredAt,
      p_name: input.name,
      p_email: input.email,
      p_phone: input.phone,
    });
    if (error) throw new PmsGuestSyncError('Mapped CRM contact update failed.');
    return data === true;
  }
}
