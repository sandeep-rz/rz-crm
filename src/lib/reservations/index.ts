export type ReservationLifecycle =
  'upcoming' | 'staying_now' | 'checked_out' | 'cancelled';

export function updateReservationQuery(
  current: URLSearchParams,
  changes: Record<string, string | null>
): URLSearchParams {
  const next = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(changes)) {
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
  }
  if (!('page' in changes)) next.delete('page');
  return next;
}

export interface ReservationRecord {
  id: string;
  contactId: string | null;
  propertyId: string;
  propertyName: string | null;
  propertyTimezone: string;
  provider: string;
  providerName: string | null;
  guestName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  reservationCode: string | null;
  status: string;
  providerStatus: string | null;
  lifecycle: ReservationLifecycle;
  checkIn: string | null;
  checkOut: string | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  pets: number | null;
  occupancyTotal: number | null;
  channel: string | null;
  totalAmount: number | null;
  currency: string | null;
  lastSyncedAt: string | null;
  totalCount: number;
}

export function propertyDate(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const value = Object.fromEntries(
      parts.map((part) => [part.type, part.value])
    );
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function classifyReservation(
  input: {
    status: string;
    checkIn: string | null;
    checkOut: string | null;
    propertyTimezone: string;
  },
  now = new Date()
): ReservationLifecycle {
  const today = propertyDate(now, input.propertyTimezone);
  if (/cancel/i.test(input.status)) return 'cancelled';
  if (/^(completed|checked[ _-]?out)$/i.test(input.status))
    return 'checked_out';
  if (input.checkOut && input.checkOut <= today) return 'checked_out';
  if (
    input.checkIn &&
    input.checkIn <= today &&
    (!input.checkOut || input.checkOut > today)
  ) {
    return 'staying_now';
  }
  return 'upcoming';
}

export function parseReservation(
  row: Record<string, unknown>
): ReservationRecord | null {
  const id = text(row.id);
  const propertyId = text(row.property_id);
  const status = text(row.status);
  const lifecycle = text(row.lifecycle);
  if (!id || !propertyId || !status || !isLifecycle(lifecycle)) return null;
  return {
    id,
    contactId: text(row.contact_id),
    propertyId,
    propertyName: text(row.property_name),
    propertyTimezone: text(row.property_timezone) ?? 'UTC',
    provider: text(row.integration_provider) ?? 'pms',
    providerName: text(row.integration_display_name),
    guestName: text(row.guest_name),
    guestPhone: text(row.guest_phone),
    guestEmail: text(row.guest_email),
    reservationCode: text(row.reservation_code),
    status,
    providerStatus: text(row.provider_status),
    lifecycle,
    checkIn: date(row.check_in),
    checkOut: date(row.check_out),
    adults: integer(row.adults),
    children: integer(row.children),
    infants: integer(row.infants),
    pets: integer(row.pets),
    occupancyTotal: integer(row.occupancy_total),
    channel: text(row.channel_name) ?? text(row.channel_code),
    totalAmount: number(row.total_amount),
    currency: text(row.currency),
    lastSyncedAt: text(row.last_synced_at),
    totalCount: integer(row.total_count) ?? 0,
  };
}

export function bookingTotalsByCurrency(
  rows: Pick<ReservationRecord, 'totalAmount' | 'currency'>[]
) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.totalAmount === null || !row.currency) continue;
    const currency = row.currency.toUpperCase();
    totals.set(currency, (totals.get(currency) ?? 0) + row.totalAmount);
  }
  return totals;
}

function isLifecycle(value: string | null): value is ReservationLifecycle {
  return (
    value === 'upcoming' ||
    value === 'staying_now' ||
    value === 'checked_out' ||
    value === 'cancelled'
  );
}
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
function date(value: unknown): string | null {
  const valueText = text(value);
  const match = valueText?.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}
function integer(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
