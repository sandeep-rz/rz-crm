import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { PmsIntegrationContext, PmsProvider } from './provider';

export interface GuestSyncContext {
  accountId: string;
  integration: PmsIntegrationContext;
  propertyId: string;
  externalPropertyId: string;
  externalGuestId: string;
  occurredAt: string;
}

export interface GuestSyncStore {
  findLinkedReservation(input: GuestSyncContext): Promise<string | null>;
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
 * Reuses the existing authenticated canonical reservation API.
 * No CRM contact is created or matched by phone/email: only an existing
 * PMS external_guest_id mapping may be updated.
 *
 * Directory-only guests cannot sync until PMS exposes a scoped getGuest API;
 * these are intentionally ignored, never matched heuristically.
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

  const reservationId = await store.findLinkedReservation(input);
  if (!reservationId) return 'unmapped';

  const reservation = await provider.getReservation({
    integration: input.integration,
    externalPropertyId: input.externalPropertyId,
    externalReservationId: reservationId,
  });

  if (reservation.externalPropertyId !== input.externalPropertyId ||
      reservation.externalId !== reservationId ||
      reservation.guest.externalId !== input.externalGuestId) {
    throw new PmsGuestSyncError('Canonical guest/reservation/property mismatch.', 'guest_mismatch');
  }

  const rawPhone = reservation.guest.phone;
  const normalized = rawPhone ? normalizePhone(rawPhone) : '';
  // Preserve an existing CRM phone if the PMS number lacks a valid E.164 country code.
  // An explicit PMS clear is represented by an empty string.
  const phone = !rawPhone ? '' : isValidE164(normalized) ? '+' + normalized : null;

  const updated = await store.updateMappedContact({
    ...input,
    name: reservation.guest.fullName,
    email: reservation.guest.email,
    phone,
  });
  return updated ? 'updated' : 'unmapped';
}

export class SupabaseGuestSyncStore implements GuestSyncStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async findLinkedReservation(input: GuestSyncContext): Promise<string | null> {
    const { data, error } = await this.admin
      .from('pms_reservations')
      .select('external_reservation_id')
      .eq('account_id', input.accountId)
      .eq('pms_integration_id', input.integration.integrationId)
      .eq('pms_property_id', input.propertyId)
      .eq('external_guest_id', input.externalGuestId)
      .not('contact_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new PmsGuestSyncError('Guest reservation mapping lookup failed.');
    return data?.external_reservation_id ?? null;
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
