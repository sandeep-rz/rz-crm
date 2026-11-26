import { RUKIYE_ZARA_PROVIDER } from '../types';
import { PmsHttpClient } from '../http-client';
import {
  PmsProviderError,
  type PmsProperty,
  type PmsProvider,
  type PmsReservation,
  type PmsReservationPage,
} from '../provider';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PmsProviderError(
      'invalid_response',
      'RZ PMS API returned an invalid object.'
    );
  return value as RecordValue;
};
const stringValue = (
  value: unknown,
  label: string,
  nullable = false
): string | null => {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim())
    throw new PmsProviderError(
      'invalid_response',
      `RZ PMS response is missing ${label}.`
    );
  return value.trim();
};
const nullableString = (value: unknown) =>
  value === null || value === undefined
    ? null
    : stringValue(value, 'a string', true);
const identifier = (value: unknown, label: string): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return String(value);
  return stringValue(value, label)!;
};
const numberValue = (
  value: unknown,
  label: string,
  nullable = true
): number | null => {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new PmsProviderError(
      'invalid_response',
      `RZ PMS response has an invalid ${label}.`
    );
  return value;
};

function propertyFrom(value: unknown): PmsProperty {
  const item = record(value);
  const address = record(item.address);
  return {
    externalId: identifier(item.id, 'property id'),
    name: stringValue(item.name, 'property name')!,
    status: stringValue(item.status, 'property status')!,
    active: item.active === true,
    timezone: nullableString(item.timezone),
    address: Object.fromEntries(
      Object.entries(address).map(([key, v]) => [
        key,
        v === null ? null : stringValue(v, `address.${key}`),
      ])
    ),
    currency: nullableString(item.currency),
    createdAt: nullableString(item.created_at),
  };
}

const reservationStatus = (value: unknown): PmsReservation['status'] => {
  if (value === 'pending' || value === 'confirmed' || value === 'cancelled') {
    return value;
  }

  throw new PmsProviderError(
    'invalid_response',
    `RZ PMS response has an invalid canonical reservation status: ${String(value)}.`
  );
};

function reservationFrom(value: unknown): PmsReservation {
  const item = record(value);
  const guest = record(item.guest);
  const occupancy = record(item.occupancy);
  const channel = record(item.channel);
  const financial = record(item.financial);
  return {
    externalId: stringValue(item.id, 'reservation id')!,
    sourceType: stringValue(item.source_type, 'source_type')!,
    externalPropertyId: identifier(item.property_id, 'property_id'),
    externalListingId: stringValue(item.listing_id, 'listing_id')!,
    reservationCode: stringValue(item.reservation_code, 'reservation_code')!,
    status: reservationStatus(item.status),
    providerStatus: stringValue(item.provider_status, 'provider_status')!,
    checkIn: nullableString(item.check_in),
    checkOut: nullableString(item.check_out),
    guest: {
      externalId: nullableString(guest.external_guest_id),
      fullName: nullableString(guest.full_name),
      email: nullableString(guest.email),
      phone: nullableString(guest.phone),
    },
    occupancy: {
      adults: numberValue(occupancy.adults, 'adults'),
      children: numberValue(occupancy.children, 'children'),
      infants: numberValue(occupancy.infants, 'infants'),
      pets: numberValue(occupancy.pets, 'pets'),
      total: numberValue(occupancy.total, 'occupancy total'),
    },
    channel: {
      code: nullableString(channel.code),
      name: nullableString(channel.name),
    },
    financial: {
      totalAmount: numberValue(financial.total_amount, 'total_amount'),
      paidAmount: numberValue(financial.paid_amount, 'paid_amount'),
      balanceDue: numberValue(financial.balance_due, 'balance_due'),
      currency: nullableString(financial.currency),
      paymentStatus: nullableString(financial.payment_status),
    },
    createdAt: nullableString(item.created_at),
    updatedAt: nullableString(item.updated_at),
  };
}

// Canonical parent contract. A multi-room stay has no single listing identity.
export function canonicalReservationFrom(value: unknown): PmsReservation {
  const wrapper = record(value);
  if (wrapper.kind === 'native') return reservationFrom(wrapper.reservation);
  if (wrapper.kind !== 'pms')
    throw new PmsProviderError('invalid_response', 'Invalid reservation kind.');
  const r = record(wrapper.reservation);
  const rooms = Array.isArray(r.rooms) ? r.rooms.map(record) : [];
  if (!rooms.length)
    throw new PmsProviderError(
      'invalid_response',
      'Missing reservation rooms.'
    );
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const aliases = rooms.map((room) =>
    identifier(room.booking_id, 'room booking')
  );
  if (
    !uuid.test(String(r.source_record_id)) ||
    aliases.some((id) => !uuid.test(id)) ||
    new Set(aliases).size !== aliases.length ||
    typeof r.source_version !== 'string' ||
    !/^[1-9]\d{0,18}$/.test(r.source_version) ||
    BigInt(r.source_version) > BigInt('9223372036854775807')
  )
    throw new PmsProviderError(
      'invalid_response',
      'Invalid canonical identity or source version.'
    );
  const listings = [
    ...new Set(
      rooms.map((room) => identifier(room.listing_id, 'room listing'))
    ),
  ];
  const guest = r.guest_resolution === 'resolved' ? record(r.guest) : {};
  return {
    externalId: identifier(r.source_record_id, 'parent reservation'),
    sourceType: 'pms_reservations',
    externalPropertyId: identifier(r.property_id, 'property'),
    externalListingId: listings.length === 1 ? listings[0] : '',
    reservationCode: stringValue(r.reservation_code, 'reservation code')!,
    status: reservationStatus(r.canonical_status),
    providerStatus:
      r.canonical_status === 'confirmed' && Number(r.cancelled_rooms) > 0
        ? 'partially_cancelled'
        : String(r.canonical_status),
    checkIn: nullableString(r.checkin_date),
    checkOut: nullableString(r.checkout_date),
    guest: {
      externalId: nullableString(guest.external_guest_id),
      fullName: nullableString(guest.full_name),
      email: nullableString(guest.email),
      phone: nullableString(guest.phone),
    },
    occupancy: {
      adults: null,
      children: null,
      infants: null,
      pets: null,
      total: numberValue(r.expected_guest_count, 'occupancy'),
    },
    channel: {
      code: nullableString(r.channel_code),
      name: nullableString(r.canonical_channel_name ?? r.channel_name),
    },
    financial: {
      totalAmount: numberValue(r.total_amount, 'total amount'),
      paidAmount: numberValue(r.paid_amount, 'paid amount'),
      balanceDue: numberValue(r.balance_due, 'balance due'),
      currency: nullableString(r.currency),
      paymentStatus: nullableString(r.payment_status),
    },
    createdAt: nullableString(r.reservation_created_at),
    updatedAt: nullableString(r.reservation_updated_at),
    sourceVersion: r.source_version as string,
    canonicalAliases: aliases,
    // An authoritative phone clear must not reuse an old mapped CRM phone
    // while the independent guest.updated delivery is still in flight.
    guestResolution:
      r.guest_resolution === 'resolved' &&
      !(
        Array.isArray(guest.cleared_fields) &&
        guest.cleared_fields.includes('phone')
      )
        ? 'resolved'
        : 'unresolved',
  };
}

export class RukiyeZaraPmsProvider implements PmsProvider {
  readonly provider = RUKIYE_ZARA_PROVIDER;
  constructor(private readonly client = new PmsHttpClient()) {}
  async getProperty({
    externalPropertyId,
  }: {
    integration: unknown;
    externalPropertyId: string;
  }) {
    const response = await this.client.get<{ data: unknown }>(
      `/v1/integrations/rz-crm/properties/${encodeURIComponent(externalPropertyId)}`
    );
    return propertyFrom(record(response).data);
  }
  async listReservations({
    externalPropertyId,
    limit,
    cursor,
    updatedSince,
  }: {
    integration: unknown;
    externalPropertyId: string;
    limit?: number;
    cursor?: string | null;
    updatedSince?: string | null;
  }): Promise<PmsReservationPage> {
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > 200)
    )
      throw new PmsProviderError(
        'configuration',
        'Reservation limit must be between 1 and 200.'
      );
    const response = record(
      await this.client.get(
        `/v1/integrations/rz-crm/properties/${encodeURIComponent(externalPropertyId)}/canonical-reservations`,
        {
          limit: Math.min(limit ?? 100, 100),
          cursor: cursor ?? undefined,
          updated_since: updatedSince ?? undefined,
        }
      )
    );
    const data = response.data;
    if (response.contract_version !== 'v2' || !Array.isArray(data))
      throw new PmsProviderError(
        'invalid_response',
        'RZ PMS reservations response is invalid.'
      );
    if (
      typeof response.sync_watermark !== 'string' ||
      !Number.isFinite(Date.parse(response.sync_watermark))
    )
      throw new PmsProviderError(
        'invalid_response',
        'Invalid synchronization watermark.'
      );
    const pagination = record(response.pagination);
    if (
      typeof pagination.has_more !== 'boolean' ||
      (pagination.has_more
        ? typeof pagination.next_cursor !== 'string' ||
          !pagination.next_cursor.trim()
        : pagination.next_cursor !== null)
    )
      throw new PmsProviderError(
        'invalid_response',
        'Invalid reservation pagination.'
      );
    return {
      syncWatermark: response.sync_watermark,
      items: data.map((item) => {
        const reservation = canonicalReservationFrom(item);
        if (reservation.externalPropertyId !== externalPropertyId)
          throw new PmsProviderError(
            'invalid_response',
            'Reservation property mismatch.'
          );
        return reservation;
      }),
      nextCursor: nullableString(pagination.next_cursor),
      hasMore: pagination.has_more === true,
    };
  }
  async getCanonicalReservation({
    externalPropertyId,
    externalReservationId,
  }: {
    externalPropertyId: string;
    externalReservationId: string;
  }): Promise<PmsReservation> {
    const response = record(
      await this.client.get(
        `/v1/integrations/rz-crm/properties/${encodeURIComponent(externalPropertyId)}/canonical-reservations/${encodeURIComponent(externalReservationId)}`
      )
    );
    if (response.contract_version !== 'v2')
      throw new PmsProviderError(
        'invalid_response',
        'Invalid canonical contract.'
      );
    const reservation = canonicalReservationFrom(response.data);
    if (
      reservation.externalPropertyId !== externalPropertyId ||
      (reservation.externalId !== externalReservationId &&
        !reservation.canonicalAliases?.includes(externalReservationId))
    )
      throw new PmsProviderError(
        'invalid_response',
        'Canonical reservation scope mismatch.'
      );
    return reservation;
  }
  async getReservation({
    externalPropertyId,
    externalReservationId,
  }: {
    integration: unknown;
    externalPropertyId: string;
    externalReservationId: string;
  }) {
    const response = await this.client.get<{ data: unknown }>(
      `/v1/integrations/rz-crm/properties/${encodeURIComponent(externalPropertyId)}/reservations/${encodeURIComponent(externalReservationId)}`
    );
    return reservationFrom(record(response).data);
  }
}
