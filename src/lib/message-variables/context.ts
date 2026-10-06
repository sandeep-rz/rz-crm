import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

export interface MessageContactContext {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  phone: string | null;
  email: string | null;
}

export interface MessageReservationContext {
  id: string;
  reference: string | null;
  status: string;
  check_in_date: string | null;
  check_out_date: string | null;
  nights: number | null;
  guest_count: number | null;
  adult_count: number | null;
  child_count: number | null;
  channel: string | null;
  /** Unformatted PostgreSQL NUMERIC representation; never used for arithmetic. */
  total_amount: string | null;
  currency: string | null;
}

export interface MessagePropertyContext {
  id: string;
  name: string | null;
}

export interface MessageWorkspaceContext {
  id: string;
  name: string | null;
}

export interface MessageVariableContext {
  contact?: MessageContactContext;
  reservation?: MessageReservationContext;
  property?: MessagePropertyContext;
  workspace: MessageWorkspaceContext;
}

export interface BuildMessageContextInput {
  accountId: string;
  contactId?: string | null;
  reservationId?: string | null;
  propertyId?: string | null;
}

export type MessageContextErrorCode =
  | 'invalid_input'
  | 'entity_not_found'
  | 'relationship_conflict'
  | 'lookup_failed';

export class MessageContextError extends Error {
  constructor(
    readonly code: MessageContextErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MessageContextError';
  }
}

interface ReservationRow {
  id: string;
  account_id: string;
  pms_property_id: string;
  contact_id: string | null;
  reservation_code: string | null;
  status: string;
  check_in: string | null;
  check_out: string | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  occupancy_total: number | null;
  channel_code: string | null;
  channel_name: string | null;
  total_amount: string | number | null;
  currency: string | null;
}

interface ContactRow {
  id: string;
  account_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

interface PropertyRow {
  id: string;
  account_id: string;
  name: string | null;
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function splitCanonicalContactName(name: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
} {
  const fullName = clean(name);
  if (!fullName) return { firstName: null, lastName: null, fullName: null };
  const parts = fullName.split(/\s+/);
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
    fullName,
  };
}

export function nightsBetween(
  checkIn: string | null,
  checkOut: string | null
): number | null {
  if (!checkIn || !checkOut) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)
  ) {
    return null;
  }
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return Math.round((end - start) / 86_400_000);
}

function normalizeContact(row: ContactRow): MessageContactContext {
  const names = splitCanonicalContactName(row.name);
  return {
    id: row.id,
    first_name: names.firstName,
    last_name: names.lastName,
    full_name: names.fullName,
    phone: clean(row.phone),
    email: clean(row.email),
  };
}

function computedGuestCount(row: ReservationRow): number | null {
  if (row.occupancy_total != null) return row.occupancy_total;
  const components = [row.adults, row.children, row.infants];
  return components.some((value) => value != null)
    ? components.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

function normalizeReservation(row: ReservationRow): MessageReservationContext {
  return {
    id: row.id,
    reference: clean(row.reservation_code),
    status: row.status,
    check_in_date: row.check_in,
    check_out_date: row.check_out,
    nights: nightsBetween(row.check_in, row.check_out),
    guest_count: computedGuestCount(row),
    adult_count: row.adults,
    child_count: row.children,
    channel: clean(row.channel_name) ?? clean(row.channel_code),
    total_amount: row.total_amount == null ? null : String(row.total_amount),
    currency: clean(row.currency),
  };
}

async function maybeSingle<T>(
  query: PromiseLike<{ data: unknown; error: unknown }>,
  failureMessage: string
): Promise<T | null> {
  const { data, error } = await query;
  if (error) {
    throw new MessageContextError('lookup_failed', failureMessage);
  }
  return (data as T | null) ?? null;
}

/**
 * Builds semantic message context exclusively from canonical CRM tables.
 * Every lookup includes account_id because callers may inject a service-role
 * client whose requests bypass RLS.
 */
export async function buildMessageContext(
  input: BuildMessageContextInput,
  db: SupabaseClient = supabaseAdmin()
): Promise<MessageVariableContext> {
  if (!clean(input.accountId)) {
    throw new MessageContextError('invalid_input', 'Account id is required.');
  }

  const workspace = await maybeSingle<{ id: string; name: string }>(
    db
      .from('accounts')
      .select('id, name')
      .eq('id', input.accountId)
      .maybeSingle(),
    'Workspace lookup failed.'
  );
  if (!workspace) {
    throw new MessageContextError('entity_not_found', 'Workspace not found.');
  }

  let reservation: ReservationRow | null = null;
  if (input.reservationId) {
    reservation = await maybeSingle<ReservationRow>(
      db
        .from('pms_reservations')
        .select(
          'id, account_id, pms_property_id, contact_id, reservation_code, status, check_in, check_out, adults, children, infants, occupancy_total, channel_code, channel_name, total_amount, currency'
        )
        .eq('id', input.reservationId)
        .eq('account_id', input.accountId)
        .maybeSingle(),
      'Reservation lookup failed.'
    );
    if (!reservation) {
      throw new MessageContextError(
        'entity_not_found',
        'Reservation not found in this workspace.'
      );
    }
  }

  const derivedPropertyId = reservation?.pms_property_id ?? null;
  if (
    input.propertyId &&
    derivedPropertyId &&
    input.propertyId !== derivedPropertyId
  ) {
    throw new MessageContextError(
      'relationship_conflict',
      'Reservation and property do not match.'
    );
  }
  const propertyId = derivedPropertyId ?? input.propertyId ?? null;
  let property: PropertyRow | null = null;
  if (propertyId) {
    property = await maybeSingle<PropertyRow>(
      db
        .from('pms_properties')
        .select('id, account_id, name')
        .eq('id', propertyId)
        .eq('account_id', input.accountId)
        .maybeSingle(),
      'Property lookup failed.'
    );
    if (!property) {
      throw new MessageContextError(
        'entity_not_found',
        'Property not found in this workspace.'
      );
    }
  }

  const associatedContactId = reservation?.contact_id ?? null;
  if (
    reservation &&
    input.contactId &&
    input.contactId !== associatedContactId
  ) {
    throw new MessageContextError(
      'relationship_conflict',
      'Reservation and contact do not match.'
    );
  }
  const contactId = reservation
    ? associatedContactId
    : (input.contactId ?? null);
  let contact: ContactRow | null = null;
  if (contactId) {
    contact = await maybeSingle<ContactRow>(
      db
        .from('contacts')
        .select('id, account_id, name, phone, email')
        .eq('id', contactId)
        .eq('account_id', input.accountId)
        .maybeSingle(),
      'Contact lookup failed.'
    );
    if (!contact) {
      throw new MessageContextError(
        'entity_not_found',
        'Contact not found in this workspace.'
      );
    }
  }

  return {
    ...(contact ? { contact: normalizeContact(contact) } : {}),
    ...(reservation ? { reservation: normalizeReservation(reservation) } : {}),
    ...(property
      ? {
          property: {
            id: property.id,
            name: clean(property.name),
          },
        }
      : {}),
    workspace: { id: workspace.id, name: clean(workspace.name) },
  };
}
