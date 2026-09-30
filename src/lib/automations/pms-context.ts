import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from './admin-client';

export interface ReservationAutomationContext {
  reservation_id: string;
  external_reservation_id: string;
  reservation_reference: string | null;
  account_id: string;
  contact_id: string | null;
  guest_name: string | null;
  property_id: string;
  property_name: string | null;
  property_timezone: string | null;
  reservation_status: string;
  provider_status: string;
  channel: string | null;
  channel_name: string | null;
  check_in: string | null;
  check_out: string | null;
  nights: number | null;
  adults: number | null;
  children: number | null;
  occupancy_total: number | null;
  total_amount: number | null;
  currency: string | null;
  pms_integration_id: string;
  provider: string;
  reservation_updated_at: string;
}

export class ReservationAutomationContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReservationAutomationContextError';
  }
}

function nightsBetween(
  checkIn: string | null,
  checkOut: string | null
): number | null {
  if (!checkIn || !checkOut) return null;
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return null;
  return Math.round((end - start) / 86_400_000);
}

export async function loadReservationAutomationContext(
  reservationId: string,
  accountId: string,
  db: SupabaseClient = supabaseAdmin()
): Promise<ReservationAutomationContext | null> {
  const { data: reservation, error: reservationError } = await db
    .from('pms_reservations')
    .select(
      'id, account_id, pms_integration_id, pms_property_id, contact_id, external_reservation_id, reservation_code, status, provider_status, check_in, check_out, adults, children, occupancy_total, channel_code, channel_name, total_amount, currency, updated_at'
    )
    .eq('id', reservationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (reservationError) {
    throw new ReservationAutomationContextError('Reservation lookup failed.');
  }
  if (!reservation) return null;

  const [
    { data: property, error: propertyError },
    { data: integration, error: integrationError },
  ] = await Promise.all([
    db
      .from('pms_properties')
      .select('id, account_id, pms_integration_id, name, timezone')
      .eq('id', reservation.pms_property_id)
      .eq('account_id', accountId)
      .eq('pms_integration_id', reservation.pms_integration_id)
      .maybeSingle(),
    db
      .from('pms_integrations')
      .select('id, account_id, provider')
      .eq('id', reservation.pms_integration_id)
      .eq('account_id', accountId)
      .maybeSingle(),
  ]);
  if (propertyError || integrationError) {
    throw new ReservationAutomationContextError(
      'Reservation relationship lookup failed.'
    );
  }
  if (!property || !integration) return null;

  let guestName: string | null = null;
  if (reservation.contact_id) {
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('id, account_id, name')
      .eq('id', reservation.contact_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (contactError) {
      throw new ReservationAutomationContextError(
        'Reservation contact lookup failed.'
      );
    }
    if (!contact) return null;
    guestName = contact.name as string | null;
  }

  return {
    reservation_id: reservation.id as string,
    external_reservation_id: reservation.external_reservation_id as string,
    reservation_reference: reservation.reservation_code as string | null,
    account_id: reservation.account_id as string,
    contact_id: reservation.contact_id as string | null,
    guest_name: guestName,
    property_id: property.id as string,
    property_name: property.name as string | null,
    property_timezone: property.timezone as string | null,
    reservation_status: reservation.status as string,
    provider_status: reservation.provider_status as string,
    channel: reservation.channel_code as string | null,
    channel_name: reservation.channel_name as string | null,
    check_in: reservation.check_in as string | null,
    check_out: reservation.check_out as string | null,
    nights: nightsBetween(
      reservation.check_in as string | null,
      reservation.check_out as string | null
    ),
    adults: reservation.adults as number | null,
    children: reservation.children as number | null,
    occupancy_total: reservation.occupancy_total as number | null,
    total_amount:
      reservation.total_amount == null
        ? null
        : Number(reservation.total_amount),
    currency: reservation.currency as string | null,
    pms_integration_id: integration.id as string,
    provider: integration.provider as string,
    reservation_updated_at: reservation.updated_at as string,
  };
}

export function reservationContextVars(
  reservation: ReservationAutomationContext
): Record<string, unknown> {
  return {
    guest_name: reservation.guest_name,
    property_name: reservation.property_name,
    check_in: reservation.check_in,
    check_out: reservation.check_out,
    reservation_reference: reservation.reservation_reference,
    channel: reservation.channel_name ?? reservation.channel,
    total_amount: reservation.total_amount,
    currency: reservation.currency,
  };
}
