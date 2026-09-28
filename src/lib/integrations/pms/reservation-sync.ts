import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils';

import type { PmsIntegrationContext, PmsReservation } from './provider';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 255;

export interface PmsReservationSyncProperty {
  id: string;
  externalPropertyId: string;
}

export interface PmsReservationSyncInput {
  accountId: string;
  integration: PmsIntegrationContext;
  property: PmsReservationSyncProperty;
  reservation: PmsReservation;
}

export interface PmsContactRecord {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
}

export interface PmsReservationRecord {
  id: string;
  externalUpdatedAt: string | null;
}

export interface PmsReservationSyncStore {
  findGuestMapping(input: {
    integrationId: string;
    externalGuestId: string;
  }): Promise<{ contactId: string } | null>;
  findContactsByPhone(
    accountId: string,
    normalizedPhone: string
  ): Promise<PmsContactRecord[]>;
  findContactsByEmail(
    accountId: string,
    normalizedEmail: string
  ): Promise<PmsContactRecord[]>;
  findContactById(
    accountId: string,
    contactId: string
  ): Promise<PmsContactRecord | null>;
  createContact(input: {
    accountId: string;
    phone: string;
    name: string | null;
    email: string | null;
  }): Promise<{ contact: PmsContactRecord; created: boolean }>;
  enrichContact(input: {
    accountId: string;
    contact: PmsContactRecord;
    phone: string | null;
    name: string | null;
    email: string | null;
  }): Promise<PmsContactRecord>;
  createGuestMapping(input: {
    accountId: string;
    integrationId: string;
    contactId: string;
    externalGuestId: string;
  }): Promise<{ contactId: string }>;
  findReservation(input: {
    accountId: string;
    integrationId: string;
    externalReservationId: string;
  }): Promise<PmsReservationRecord | null>;
  saveReservation(input: {
    accountId: string;
    integrationId: string;
    propertyId: string;
    contactId: string | null;
    reservation: PmsReservation;
    syncedAt: string;
    existing: PmsReservationRecord | null;
  }): Promise<{ id: string; skippedStale: boolean }>;
}

export interface PmsReservationSyncResult {
  reservationId: string;
  contactId: string | null;
  contactCreated: boolean;
  externalGuestMapped: boolean;
  skippedStale: boolean;
}

export class PmsReservationSyncError extends Error {
  constructor(
    message: string,
    public readonly code = 'reservation_sync_failed'
  ) {
    super(message);
    this.name = 'PmsReservationSyncError';
  }
}

function normalizedEmail(value: string | null): string | null {
  if (!value) return null;
  const result = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(result) ? result : null;
}

function isQuestionableEmail(value: string): boolean {
  const [local, domain] = value.split('@');
  const normalizedDomain = domain?.toLowerCase() ?? '';
  if (
    [
      'privaterelay.appleid.com',
      'guest.booking.com',
      'relay.booking.com',
      'guest.airbnb.com',
      'm.expedia.com',
    ].includes(normalizedDomain)
  ) {
    return true;
  }
  return /(^|[._-])(no[-_]?reply|relay|noreply)([._-]|$)/i.test(local ?? '');
}

function safeName(value: string | null): string | null {
  if (!value) return null;
  const result = value.trim();
  return result ? result.slice(0, MAX_NAME_LENGTH) : null;
}

function incomingTimestamp(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function shouldEnrichEmail(email: string | null): email is string {
  return email !== null && !isQuestionableEmail(email);
}

async function resolveContact(
  input: PmsReservationSyncInput,
  store: PmsReservationSyncStore
): Promise<{ contactId: string | null; created: boolean; mapped: boolean }> {
  const externalGuestId = input.reservation.guest.externalId?.trim() || null;
  const normalizedPhone = normalizePhone(input.reservation.guest.phone ?? '');
  const validPhone = isValidE164(normalizedPhone) ? normalizedPhone : null;
  const email = normalizedEmail(input.reservation.guest.email);
  const safeEmail = shouldEnrichEmail(email) ? email : null;
  if (externalGuestId) {
    const mapped = await store.findGuestMapping({
      integrationId: input.integration.integrationId,
      externalGuestId,
    });
    if (mapped) {
      const mappedContact = await store.findContactById(
        input.accountId,
        mapped.contactId
      );
      if (mappedContact) {
        await store.enrichContact({
          accountId: input.accountId,
          contact: mappedContact,
          phone: validPhone ? `+${validPhone}` : null,
          name: safeName(input.reservation.guest.fullName),
          email: safeEmail,
        });
      }
      return { contactId: mapped.contactId, created: false, mapped: true };
    }
  }

  let contact: PmsContactRecord | null = null;
  let phoneAmbiguous = false;
  let emailAmbiguous = false;

  if (validPhone) {
    const phoneMatches = await store.findContactsByPhone(
      input.accountId,
      validPhone
    );
    if (phoneMatches.length === 1) contact = phoneMatches[0];
    else if (phoneMatches.length > 1) phoneAmbiguous = true;
  }
  if (!contact && safeEmail) {
    const emailMatches = await store.findContactsByEmail(
      input.accountId,
      safeEmail
    );
    if (emailMatches.length === 1) contact = emailMatches[0];
    else if (emailMatches.length > 1) emailAmbiguous = true;
  }

  let created = false;
  const canCreateWithPhone = validPhone !== null && !phoneAmbiguous;
  const canCreateForStableGuest = externalGuestId !== null;
  const canCreateForSafeEmail =
    !validPhone && safeEmail !== null && !emailAmbiguous;
  if (
    !contact &&
    (canCreateWithPhone || canCreateForStableGuest || canCreateForSafeEmail)
  ) {
    const result = await store.createContact({
      accountId: input.accountId,
      // contacts.phone deliberately uses '' for a missing phone. This is the
      // existing BSUID-only contact convention from migration 040; the
      // normalized-phone unique index excludes the empty value.
      phone: canCreateWithPhone ? `+${validPhone}` : '',
      name: safeName(input.reservation.guest.fullName),
      email: emailAmbiguous ? null : safeEmail,
    });
    contact = result.contact;
    created = result.created;
  }

  if (contact) {
    contact = await store.enrichContact({
      accountId: input.accountId,
      contact,
      phone: validPhone ? `+${validPhone}` : null,
      name: safeName(input.reservation.guest.fullName),
      email: safeEmail,
    });
  }

  let mapped = false;
  if (contact && externalGuestId) {
    const mapping = await store.createGuestMapping({
      accountId: input.accountId,
      integrationId: input.integration.integrationId,
      contactId: contact.id,
      externalGuestId,
    });
    mapped = true;
    if (mapping.contactId !== contact.id)
      contact = await store.findContactById(input.accountId, mapping.contactId);
  }

  return { contactId: contact?.id ?? null, created, mapped };
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
  if (input.integration.provider.trim() === '') {
    throw new PmsReservationSyncError('PMS provider is required.');
  }

  const contact = await resolveContact(input, store);
  const existing = await store.findReservation({
    accountId: input.accountId,
    integrationId: input.integration.integrationId,
    externalReservationId: input.reservation.externalId,
  });
  const saved = await store.saveReservation({
    accountId: input.accountId,
    integrationId: input.integration.integrationId,
    propertyId: input.property.id,
    contactId: contact.contactId,
    reservation: input.reservation,
    syncedAt: new Date().toISOString(),
    existing,
  });

  return {
    reservationId: saved.id,
    contactId: contact.contactId,
    contactCreated: contact.created,
    externalGuestMapped: contact.mapped,
    skippedStale: saved.skippedStale,
  };
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

export class SupabasePmsReservationSyncStore implements PmsReservationSyncStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async findGuestMapping(input: {
    integrationId: string;
    externalGuestId: string;
  }) {
    const { data, error } = await this.admin
      .from('pms_contact_external_identities')
      .select('contact_id')
      .eq('pms_integration_id', input.integrationId)
      .eq('external_guest_id', input.externalGuestId)
      .maybeSingle();
    if (error)
      throw new PmsReservationSyncError('Guest identity lookup failed.');
    return data ? { contactId: data.contact_id as string } : null;
  }

  async findContactsByPhone(accountId: string, normalizedPhone: string) {
    const { data, error } = await this.admin
      .from('contacts')
      .select('id, phone, name, email')
      .eq('account_id', accountId)
      .eq('phone_normalized', normalizedPhone);
    if (error)
      throw new PmsReservationSyncError('Phone contact lookup failed.');
    return (data ?? []) as PmsContactRecord[];
  }

  async findContactsByEmail(accountId: string, email: string) {
    const { data, error } = await this.admin
      .from('contacts')
      .select('id, phone, name, email')
      .eq('account_id', accountId)
      .ilike('email', email);
    if (error)
      throw new PmsReservationSyncError('Email contact lookup failed.');
    return (data ?? []) as PmsContactRecord[];
  }

  async findContactById(accountId: string, contactId: string) {
    const { data, error } = await this.admin
      .from('contacts')
      .select('id, phone, name, email')
      .eq('account_id', accountId)
      .eq('id', contactId)
      .maybeSingle();
    if (error) throw new PmsReservationSyncError('Contact lookup failed.');
    return data ? (data as PmsContactRecord) : null;
  }

  async createContact(input: {
    accountId: string;
    phone: string;
    name: string | null;
    email: string | null;
  }) {
    const userId = await resolveAuditUserId(this.admin, input.accountId);
    const { data, error } = await this.admin
      .from('contacts')
      .insert({
        account_id: input.accountId,
        user_id: userId,
        phone: input.phone,
        name: input.name,
        email: input.email,
      })
      .select('id, phone, name, email')
      .single();
    if (error) {
      if (isUniqueViolation(error)) {
        const normalized = normalizePhone(input.phone);
        const matches = await this.findContactsByPhone(
          input.accountId,
          normalized
        );
        if (matches.length === 1)
          return { contact: matches[0], created: false };
      }
      throw new PmsReservationSyncError('Contact creation failed.');
    }
    return { contact: data as PmsContactRecord, created: true };
  }

  async enrichContact(input: {
    accountId: string;
    contact: PmsContactRecord;
    phone: string | null;
    name: string | null;
    email: string | null;
  }) {
    const patch: Record<string, string> = {};
    if (!input.contact.phone && input.phone) patch.phone = input.phone;
    if (!input.contact.name && input.name) patch.name = input.name;
    if (!input.contact.email && input.email) patch.email = input.email;
    if (Object.keys(patch).length === 0) return input.contact;
    const { data, error } = await this.admin
      .from('contacts')
      .update(patch)
      .eq('id', input.contact.id)
      .eq('account_id', input.accountId)
      .select('id, phone, name, email')
      .single();
    if (error || !data)
      throw new PmsReservationSyncError('Contact enrichment failed.');
    return data as PmsContactRecord;
  }

  async createGuestMapping(input: {
    accountId: string;
    integrationId: string;
    contactId: string;
    externalGuestId: string;
  }) {
    const { data, error } = await this.admin
      .from('pms_contact_external_identities')
      .insert({
        account_id: input.accountId,
        pms_integration_id: input.integrationId,
        contact_id: input.contactId,
        external_guest_id: input.externalGuestId,
      })
      .select('contact_id')
      .single();
    if (!error && data) return { contactId: data.contact_id as string };
    if (isUniqueViolation(error)) {
      const winner = await this.findGuestMapping({
        integrationId: input.integrationId,
        externalGuestId: input.externalGuestId,
      });
      if (winner) return winner;
    }
    throw new PmsReservationSyncError('Guest identity mapping failed.');
  }

  async findReservation(input: {
    accountId: string;
    integrationId: string;
    externalReservationId: string;
  }) {
    const { data, error } = await this.admin
      .from('pms_reservations')
      .select('id, external_updated_at')
      .eq('account_id', input.accountId)
      .eq('pms_integration_id', input.integrationId)
      .eq('external_reservation_id', input.externalReservationId)
      .maybeSingle();
    if (error) throw new PmsReservationSyncError('Reservation lookup failed.');
    return data
      ? ({
          id: data.id as string,
          externalUpdatedAt: data.external_updated_at as string | null,
        } satisfies PmsReservationRecord)
      : null;
  }

  async saveReservation(input: {
    accountId: string;
    integrationId: string;
    propertyId: string;
    contactId: string | null;
    reservation: PmsReservation;
    syncedAt: string;
    existing: PmsReservationRecord | null;
  }): Promise<{ id: string; skippedStale: boolean }> {
    const incoming = incomingTimestamp(input.reservation.updatedAt);
    const stored = incomingTimestamp(input.existing?.externalUpdatedAt ?? null);
    if (
      input.existing &&
      stored !== null &&
      (incoming === null || stored > incoming)
    ) {
      return { id: input.existing.id, skippedStale: true };
    }
    const row = {
      account_id: input.accountId,
      pms_integration_id: input.integrationId,
      pms_property_id: input.propertyId,
      contact_id: input.contactId,
      external_reservation_id: input.reservation.externalId,
      external_guest_id: input.reservation.guest.externalId,
      external_listing_id: input.reservation.externalListingId,
      reservation_code: input.reservation.reservationCode,
      status: input.reservation.status,
      provider_status: input.reservation.status,
      check_in: input.reservation.checkIn,
      check_out: input.reservation.checkOut,
      adults: input.reservation.occupancy.adults,
      children: input.reservation.occupancy.children,
      infants: input.reservation.occupancy.infants,
      pets: input.reservation.occupancy.pets,
      occupancy_total: input.reservation.occupancy.total,
      channel_code: input.reservation.channel.code,
      channel_name: input.reservation.channel.name,
      total_amount: input.reservation.financial.totalAmount,
      paid_amount: input.reservation.financial.paidAmount,
      balance_due: input.reservation.financial.balanceDue,
      currency: input.reservation.financial.currency,
      payment_status: input.reservation.financial.paymentStatus,
      external_created_at: input.reservation.createdAt,
      external_updated_at: input.reservation.updatedAt,
      last_synced_at: input.syncedAt,
      metadata: { source_type: input.reservation.sourceType },
    };
    if (input.existing) {
      let updateQuery = this.admin
        .from('pms_reservations')
        .update(row)
        .eq('id', input.existing.id)
        .eq('account_id', input.accountId)
        .eq('pms_integration_id', input.integrationId);
      if (input.existing.externalUpdatedAt === null) {
        updateQuery = updateQuery.is('external_updated_at', null);
      } else {
        updateQuery = updateQuery.eq(
          'external_updated_at',
          input.existing.externalUpdatedAt
        );
      }
      const { data: updated, error } = await updateQuery
        .select('id')
        .maybeSingle();
      if (error)
        throw new PmsReservationSyncError('Reservation update failed.');
      if (!updated) return { id: input.existing.id, skippedStale: true };
      return { id: input.existing.id, skippedStale: false };
    }
    const { data, error } = await this.admin
      .from('pms_reservations')
      .insert(row)
      .select('id')
      .single();
    if (!error && data) return { id: data.id as string, skippedStale: false };
    if (isUniqueViolation(error)) {
      const raced = await this.findReservation({
        accountId: input.accountId,
        integrationId: input.integrationId,
        externalReservationId: input.reservation.externalId,
      });
      if (raced) return this.saveReservation({ ...input, existing: raced });
    }
    throw new PmsReservationSyncError('Reservation insert failed.');
  }
}
