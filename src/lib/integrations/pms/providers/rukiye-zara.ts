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
        `/v1/integrations/rz-crm/properties/${encodeURIComponent(externalPropertyId)}/reservations`,
        {
          limit,
          cursor: cursor ?? undefined,
          updated_since: updatedSince ?? undefined,
        }
      )
    );
    const data = response.data;
    if (!Array.isArray(data))
      throw new PmsProviderError(
        'invalid_response',
        'RZ PMS reservations response is invalid.'
      );
    const pagination = record(response.pagination);
    return {
      items: data.map(reservationFrom),
      nextCursor: nullableString(pagination.next_cursor),
      hasMore: pagination.has_more === true,
    };
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
