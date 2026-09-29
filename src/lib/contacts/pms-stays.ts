export const CONTACT_COLUMNS = 'id, account_id';

export const RESERVATION_COLUMNS =
  'id, account_id, contact_id, pms_property_id, reservation_code, status, provider_status, check_in, check_out, adults, children, infants, pets, channel_code, channel_name, total_amount, currency, last_synced_at';

export const PROPERTY_COLUMNS = 'id, account_id, name';

export type StayTiming = 'current' | 'upcoming' | 'past' | 'cancelled';

export type StayPresentationStatus =
  | 'inHouse'
  | 'upcoming'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'pending'
  | 'default';

export interface ContactStay {
  id: string;
  propertyName: string | null;
  reservationCode: string | null;
  status: string;
  providerStatus: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  pets: number | null;
  channel: string | null;
  totalAmount: number | null;
  currency: string | null;
  lastSyncedAt: string | null;
  timing: StayTiming;
}

export interface StayGroups {
  current: ContactStay[];
  upcoming: ContactStay[];
  past: ContactStay[];
  cancelled: ContactStay[];
}

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

export interface StayQuery extends PromiseLike<QueryResult> {
  select: (columns: string) => StayQuery;
  eq: (column: string, value: string) => StayQuery;
  in: (column: string, values: string[]) => StayQuery;
  order: (column: string, options: { ascending: boolean }) => StayQuery;
  maybeSingle: () => Promise<QueryResult>;
}

export interface StayReadClient {
  from: (table: string) => StayQuery;
}

export interface StayLoadInput {
  accountId: string;
  contactId: string;
  today?: string;
}

export function calendarToday(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function nightsBetween(
  checkIn: string | null,
  checkOut: string | null
): number | null {
  if (!checkIn || !checkOut) return null;
  const start = utcDay(checkIn);
  const end = utcDay(checkOut);
  if (start === null || end === null) return null;
  const nights = Math.round((end - start) / 86_400_000);
  return nights > 0 ? nights : null;
}

export function classifyStay(
  input: { status: string; checkIn: string | null; checkOut: string | null },
  today: string
): StayTiming {
  if (/cancel/i.test(input.status)) return 'cancelled';
  if (/^(completed|checked[ _-]?out)$/i.test(input.status)) return 'past';
  if (input.checkOut && input.checkOut <= today) return 'past';
  if (input.checkIn && input.checkIn <= today) return 'current';
  return 'upcoming';
}

export function stayStatusLabel(status: string): string {
  const trimmed = status.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function groupStays(stays: ContactStay[]): StayGroups {
  const current = stays
    .filter((stay) => stay.timing === 'current')
    .sort((a, b) => compareDate(a.checkIn, b.checkIn, 'asc'));
  const upcoming = stays
    .filter((stay) => stay.timing === 'upcoming')
    .sort((a, b) => compareDate(a.checkIn, b.checkIn, 'asc'));
  const past = stays
    .filter((stay) => stay.timing === 'past')
    .sort((a, b) => compareDate(a.checkOut, b.checkOut, 'desc'));
  const cancelled = stays
    .filter((stay) => stay.timing === 'cancelled')
    .sort((a, b) => compareDate(a.checkIn, b.checkIn, 'desc'));
  return { current, upcoming, past, cancelled };
}

export function mostRelevantStay(stays: ContactStay[]): ContactStay | null {
  const groups = groupStays(stays);
  return groups.current[0] ?? groups.upcoming[0] ?? groups.past[0] ?? null;
}

export function stayPresentationStatus(
  stay: ContactStay
): StayPresentationStatus {
  if (stay.timing === 'cancelled') return 'cancelled';
  if (stay.timing === 'current') return 'inHouse';
  if (stay.timing === 'past') return 'completed';
  if (stay.checkIn) return 'upcoming';

  const value = stay.status.toLowerCase();
  if (value === 'confirmed') return 'confirmed';
  if (value === 'pending') return 'pending';
  return 'default';
}

export function formatStayDate(isoDate: string, locale: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

export function formatStayDateShort(isoDate: string, locale: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(year, month - 1, day));
}

export function formatStayMonth(isoDate: string, locale: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

export function formatStayTotal(
  amount: number,
  currency: string | null,
  locale: string
): string {
  if (currency && /^[A-Z]{3}$/i.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      // Fall through for unknown currency codes from the provider.
    }
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
    amount
  );
}

export function formatSyncedAt(value: string, locale: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function toContactStay(
  row: Record<string, unknown>,
  propertyName: string | null,
  today: string
): ContactStay | null {
  const id = textOrNull(row.id);
  const status = textOrNull(row.status);
  if (!id || !status) return null;
  const checkIn = dateOrNull(row.check_in);
  const checkOut = dateOrNull(row.check_out);
  const providerStatus = textOrNull(row.provider_status);
  return {
    id,
    propertyName: textOrNull(propertyName),
    reservationCode: textOrNull(row.reservation_code),
    status,
    providerStatus:
      providerStatus && providerStatus.toLowerCase() !== status.toLowerCase()
        ? providerStatus
        : null,
    checkIn,
    checkOut,
    nights: nightsBetween(checkIn, checkOut),
    adults: countOrNull(row.adults),
    children: countOrNull(row.children),
    infants: countOrNull(row.infants),
    pets: countOrNull(row.pets),
    channel: textOrNull(row.channel_name) ?? textOrNull(row.channel_code),
    totalAmount: amountOrNull(row.total_amount),
    currency: textOrNull(row.currency),
    lastSyncedAt: textOrNull(row.last_synced_at),
    timing: classifyStay({ status, checkIn, checkOut }, today),
  };
}

export async function loadContactStays(
  client: StayReadClient,
  input: StayLoadInput
): Promise<ContactStay[]> {
  const accountId = input.accountId.trim();
  const contactId = input.contactId.trim();
  if (!accountId || !contactId) return [];
  const today = input.today ?? calendarToday();
  const contact = await loadWorkspaceContact(client, accountId, contactId);
  if (!contact) return [];

  const reservationResult = await read(
    client
      .from('pms_reservations')
      .select(RESERVATION_COLUMNS)
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('check_in', { ascending: false })
  );
  const rows = records(reservationResult.data).filter(
    (row) => row.account_id === accountId && row.contact_id === contactId
  );
  const names = await loadPropertyNames(client, accountId, rows);
  return rows.flatMap((row) => {
    const propertyId = textOrNull(row.pms_property_id);
    const stay = toContactStay(
      row,
      propertyId ? (names.get(propertyId) ?? null) : null,
      today
    );
    return stay ? [stay] : [];
  });
}

export async function loadContactStay(
  client: StayReadClient,
  input: StayLoadInput & { reservationId: string }
): Promise<ContactStay | null> {
  const accountId = input.accountId.trim();
  const contactId = input.contactId.trim();
  const reservationId = input.reservationId.trim();
  if (!accountId || !contactId || !reservationId) return null;
  const today = input.today ?? calendarToday();
  const contact = await loadWorkspaceContact(client, accountId, contactId);
  if (!contact) return null;

  const result = await client
    .from('pms_reservations')
    .select(RESERVATION_COLUMNS)
    .eq('id', reservationId)
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = record(result.data);
  if (!row) return null;
  if (
    row.id !== reservationId ||
    row.account_id !== accountId ||
    row.contact_id !== contactId
  ) {
    return null;
  }
  const names = await loadPropertyNames(client, accountId, [row]);
  const propertyId = textOrNull(row.pms_property_id);
  return toContactStay(
    row,
    propertyId ? (names.get(propertyId) ?? null) : null,
    today
  );
}

async function loadWorkspaceContact(
  client: StayReadClient,
  accountId: string,
  contactId: string
): Promise<Record<string, unknown> | null> {
  const result = await client
    .from('contacts')
    .select(CONTACT_COLUMNS)
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const contact = record(result.data);
  if (!contact || contact.id !== contactId || contact.account_id !== accountId)
    return null;
  return contact;
}

async function loadPropertyNames(
  client: StayReadClient,
  accountId: string,
  rows: Record<string, unknown>[]
): Promise<Map<string, string | null>> {
  const propertyIds = [
    ...new Set(
      rows
        .map((row) => textOrNull(row.pms_property_id))
        .filter((id): id is string => id !== null)
    ),
  ];
  const names = new Map<string, string | null>();
  if (propertyIds.length === 0) return names;
  const result = await read(
    client
      .from('pms_properties')
      .select(PROPERTY_COLUMNS)
      .eq('account_id', accountId)
      .in('id', propertyIds)
  );
  for (const property of records(result.data)) {
    if (property.account_id !== accountId) continue;
    const id = textOrNull(property.id);
    if (!id || !propertyIds.includes(id)) continue;
    names.set(id, textOrNull(property.name));
  }
  return names;
}

async function read(query: StayQuery): Promise<QueryResult> {
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result;
}

function records(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is Record<string, unknown> => isRecord(item));
}

function record(data: unknown): Record<string, unknown> | null {
  return isRecord(data) ? data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function countOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(count) || count < 0) return null;
  return count;
}

function amountOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function dateOrNull(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : null;
}

function utcDay(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function compareDate(
  a: string | null,
  b: string | null,
  direction: 'asc' | 'desc'
): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const order = a < b ? -1 : 1;
  return direction === 'asc' ? order : -order;
}
