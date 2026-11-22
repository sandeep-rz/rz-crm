import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

import type { PmsIntegrationContext, PmsReservation } from './provider';

export interface PmsReservationSyncInput {
  accountId: string;
  integration: PmsIntegrationContext;
  property: { id: string; externalPropertyId: string };
  reservation: PmsReservation;
}

export interface PmsReservationSyncResult {
  reservationId: string;
  contactId: string | null;
  contactCreated: boolean;
  externalGuestMapped: boolean;
  skippedStale: boolean;
}

type ContactPatch = Partial<Record<'phone' | 'name' | 'email', string | null>>;

export interface PmsReservationSyncStore {
  upsert(
    input: PmsReservationSyncInput,
    guestPatch: ContactPatch
  ): Promise<PmsReservationSyncResult>;
}

export class PmsReservationSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmsReservationSyncError';
  }
}

function safeEmail(value: string | null): string | undefined {
  const email = value?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  const [local, domain] = email.split('@');
  if (
    [
      'privaterelay.appleid.com',
      'guest.booking.com',
      'relay.booking.com',
      'guest.airbnb.com',
      'm.expedia.com',
    ].includes(domain) ||
    /(^|[._-])(no[-_]?reply|relay|noreply)([._-]|$)/i.test(local)
  )
    return;
  return email;
}

export function normalizePmsGuestPatch(
  guest: PmsReservation['guest']
): ContactPatch {
  const patch: ContactPatch = {};
  const phone = parseInternationalPhone(
    guest.phone?.trim().replace(/^00/, '+')
  );
  const name = guest.fullName?.trim().slice(0, 255);
  const email = safeEmail(guest.email);
  if (phone) patch.phone = `+${phone}`;
  if (name) patch.name = name;
  if (email) patch.email = email;
  // Legacy providers use null for unknown data. Only an explicit clear
  // instruction can remove an existing value.
  for (const field of guest.clearedFields ?? []) patch[field] = null;
  return patch;
}

export async function syncPmsReservation(
  input: PmsReservationSyncInput,
  store: PmsReservationSyncStore = new SupabasePmsReservationSyncStore()
): Promise<PmsReservationSyncResult> {
  if (input.integration.accountId !== input.accountId) {
    throw new PmsReservationSyncError('Integration/account context mismatch.');
  }
  if (
    input.reservation.externalPropertyId !== input.property.externalPropertyId
  ) {
    throw new PmsReservationSyncError(
      'Reservation belongs to a different PMS property.'
    );
  }
  if (!input.integration.provider.trim()) {
    throw new PmsReservationSyncError('PMS provider is required.');
  }
  return store.upsert(input, normalizePmsGuestPatch(input.reservation.guest));
}

export class SupabasePmsReservationSyncStore implements PmsReservationSyncStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async upsert(input: PmsReservationSyncInput, guestPatch: ContactPatch) {
    const { reservation } = input;
    const { data, error } = await this.admin.rpc(
      'sync_pms_reservation_contact',
      {
        p_account_id: input.accountId,
        p_integration_id: input.integration.integrationId,
        p_property_id: input.property.id,
        p_external_property_id: input.property.externalPropertyId,
        p_provider: input.integration.provider,
        p_guest: guestPatch,
        p_reservation: {
          external_reservation_id: reservation.externalId,
          external_guest_id: reservation.guest.externalId?.trim() || null,
          external_listing_id: reservation.externalListingId,
          reservation_code: reservation.reservationCode,
          status: reservation.status,
          provider_status: reservation.providerStatus,
          check_in: reservation.checkIn,
          check_out: reservation.checkOut,
          adults: reservation.occupancy.adults,
          children: reservation.occupancy.children,
          infants: reservation.occupancy.infants,
          pets: reservation.occupancy.pets,
          occupancy_total: reservation.occupancy.total,
          channel_code: reservation.channel.code,
          channel_name: reservation.channel.name,
          total_amount: reservation.financial.totalAmount,
          paid_amount: reservation.financial.paidAmount,
          balance_due: reservation.financial.balanceDue,
          currency: reservation.financial.currency,
          payment_status: reservation.financial.paymentStatus,
          external_created_at: reservation.createdAt,
          external_updated_at: reservation.updatedAt,
          metadata: { source_type: reservation.sourceType },
        },
      }
    );
    if (error || !data)
      throw new PmsReservationSyncError('Reservation contact sync failed.');
    return data as PmsReservationSyncResult;
  }
}
