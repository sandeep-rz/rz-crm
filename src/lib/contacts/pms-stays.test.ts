import { describe, expect, it } from 'vitest';

import {
  CONTACT_COLUMNS,
  PROPERTY_COLUMNS,
  RESERVATION_COLUMNS,
  classifyStay,
  groupStays,
  loadContactStay,
  loadContactStays,
  nightsBetween,
  toContactStay,
  type StayQuery,
  type StayReadClient,
} from './pms-stays';

const TODAY = '2026-09-28';
const ACCOUNT = 'account-1';
const CONTACT = 'contact-1';

interface Call {
  table: string;
  columns?: string;
  eq: [string, string][];
  in: [string, string[]][];
}

function clientFor(options: {
  contact?: Record<string, unknown> | null;
  reservations?: Record<string, unknown>[];
  reservation?: Record<string, unknown> | null;
  properties?: Record<string, unknown>[];
}): { client: StayReadClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: StayReadClient = {
    from(table: string) {
      const call: Call = { table, eq: [], in: [] };
      calls.push(call);
      const result = {
        data: dataFor(table, options),
        error: null,
      };
      const builder = {
        select(columns: string) {
          call.columns = columns;
          return builder;
        },
        eq(column: string, value: string) {
          call.eq.push([column, value]);
          return builder;
        },
        in(column: string, values: string[]) {
          call.in.push([column, values]);
          return builder;
        },
        order() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(result);
        },
        then(
          onFulfilled: (value: typeof result) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) {
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
      return builder as StayQuery;
    },
  };
  return { client, calls };
}

function dataFor(
  table: string,
  options: {
    contact?: Record<string, unknown> | null;
    reservations?: Record<string, unknown>[];
    reservation?: Record<string, unknown> | null;
    properties?: Record<string, unknown>[];
  }
) {
  if (table === 'contacts') {
    return options.contact === undefined
      ? { id: CONTACT, account_id: ACCOUNT }
      : options.contact;
  }
  if (table === 'pms_properties') return options.properties ?? [];
  if (options.reservation !== undefined) return options.reservation;
  return options.reservations ?? [];
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stay-1',
    account_id: ACCOUNT,
    contact_id: CONTACT,
    pms_property_id: 'property-1',
    reservation_code: 'RZ-100',
    status: 'confirmed',
    provider_status: 'confirmed',
    check_in: '2026-10-02',
    check_out: '2026-10-05',
    adults: 2,
    children: 1,
    infants: null,
    pets: null,
    channel_code: 'airbnb',
    channel_name: 'Airbnb',
    total_amount: 1200,
    currency: 'INR',
    last_synced_at: '2026-09-28T08:00:00.000Z',
    metadata: { secret: true },
    pms_integration_id: 'integration-1',
    ...overrides,
  };
}

describe('stay presentation', () => {
  it('maps one reservation and omits internal fields', () => {
    const stay = toContactStay(reservation(), 'Palm House', TODAY);
    expect(stay).toMatchObject({
      propertyName: 'Palm House',
      reservationCode: 'RZ-100',
      status: 'confirmed',
      providerStatus: null,
      checkIn: '2026-10-02',
      checkOut: '2026-10-05',
      nights: 3,
      adults: 2,
      children: 1,
      channel: 'Airbnb',
      totalAmount: 1200,
      currency: 'INR',
      timing: 'upcoming',
    });
    expect(stay).not.toHaveProperty('metadata');
    expect(stay).not.toHaveProperty('account_id');
    expect(stay).not.toHaveProperty('pms_integration_id');
  });

  it('groups upcoming, current, past, and cancelled stays', () => {
    const stays = [
      toContactStay(
        reservation({
          id: 'future',
          check_in: '2026-10-02',
          check_out: '2026-10-05',
        }),
        'Palm House',
        TODAY
      ),
      toContactStay(
        reservation({
          id: 'now',
          check_in: '2026-09-27',
          check_out: '2026-09-30',
          status: 'confirmed',
        }),
        'Palm House',
        TODAY
      ),
      toContactStay(
        reservation({
          id: 'done',
          check_in: '2026-08-01',
          check_out: '2026-08-04',
          status: 'completed',
        }),
        'Palm House',
        TODAY
      ),
      toContactStay(
        reservation({
          id: 'void',
          check_in: '2026-11-01',
          check_out: '2026-11-03',
          status: 'cancelled',
        }),
        'Palm House',
        TODAY
      ),
    ].filter((stay) => stay !== null);
    expect(
      classifyStay(
        { status: 'canceled', checkIn: '2026-10-01', checkOut: '2026-10-02' },
        TODAY
      )
    ).toBe('cancelled');
    const groups = groupStays(stays);
    expect(groups.upcomingCurrent.map((stay) => stay.id)).toEqual([
      'now',
      'future',
    ]);
    expect(groups.past.map((stay) => stay.id)).toEqual(['done']);
    expect(groups.cancelled.map((stay) => stay.id)).toEqual(['void']);
  });

  it('keeps reservations across more than one property', async () => {
    const { client } = clientFor({
      reservations: [
        reservation({ id: 'a', pms_property_id: 'property-1' }),
        reservation({
          id: 'b',
          pms_property_id: 'property-2',
          reservation_code: 'RZ-200',
        }),
      ],
      properties: [
        { id: 'property-1', account_id: ACCOUNT, name: 'Palm House' },
        { id: 'property-2', account_id: ACCOUNT, name: 'Hill Cottage' },
      ],
    });
    const stays = await loadContactStays(client, {
      accountId: ACCOUNT,
      contactId: CONTACT,
      today: TODAY,
    });
    expect(stays.map((stay) => stay.propertyName).sort()).toEqual([
      'Hill Cottage',
      'Palm House',
    ]);
  });

  it('omits missing money, channel, and occupancy', () => {
    const stay = toContactStay(
      reservation({
        channel_name: null,
        channel_code: '  ',
        total_amount: null,
        currency: null,
        adults: null,
        children: null,
        infants: null,
        pets: null,
        check_in: null,
        check_out: null,
      }),
      null,
      TODAY
    );
    expect(stay).toMatchObject({
      channel: null,
      totalAmount: null,
      currency: null,
      adults: null,
      children: null,
      infants: null,
      pets: null,
      nights: null,
      propertyName: null,
      timing: 'upcoming',
    });
    expect(nightsBetween('2026-10-05', '2026-10-05')).toBeNull();
  });

  it('shows provider status only when it differs', () => {
    const stay = toContactStay(
      reservation({
        status: 'confirmed',
        provider_status: 'modified',
      }),
      'Palm House',
      TODAY
    );
    expect(stay?.providerStatus).toBe('modified');
  });
});

describe('stay account isolation', () => {
  it('returns no stays for a contact with none', async () => {
    const { client, calls } = clientFor({ reservations: [] });
    const stays = await loadContactStays(client, {
      accountId: ACCOUNT,
      contactId: CONTACT,
      today: TODAY,
    });
    expect(stays).toEqual([]);
    const reservationCall = calls.find(
      (call) => call.table === 'pms_reservations'
    );
    expect(reservationCall?.eq).toEqual([
      ['account_id', ACCOUNT],
      ['contact_id', CONTACT],
    ]);
    expect(reservationCall?.columns).toBe(RESERVATION_COLUMNS);
    expect(RESERVATION_COLUMNS).not.toContain('metadata');
    expect(RESERVATION_COLUMNS).not.toContain('pms_integration_id');
    expect(calls.find((call) => call.table === 'contacts')?.columns).toBe(
      CONTACT_COLUMNS
    );
  });

  it('does not read reservations when the contact is outside the workspace', async () => {
    const { client, calls } = clientFor({ contact: null });
    const stays = await loadContactStays(client, {
      accountId: ACCOUNT,
      contactId: 'other-contact',
      today: TODAY,
    });
    expect(stays).toEqual([]);
    expect(calls.map((call) => call.table)).toEqual(['contacts']);
  });

  it('discards a reservation that belongs to another account', async () => {
    const { client, calls } = clientFor({
      reservation: reservation({
        id: 'foreign-stay',
        account_id: 'account-2',
        contact_id: CONTACT,
      }),
    });
    const stay = await loadContactStay(client, {
      accountId: ACCOUNT,
      contactId: CONTACT,
      reservationId: 'foreign-stay',
      today: TODAY,
    });
    expect(stay).toBeNull();
    const reservationCall = calls.find(
      (call) => call.table === 'pms_reservations'
    );
    expect(reservationCall?.eq).toEqual([
      ['id', 'foreign-stay'],
      ['account_id', ACCOUNT],
      ['contact_id', CONTACT],
    ]);
    expect(PROPERTY_COLUMNS).toBe('id, account_id, name');
  });

  it('ignores a property name from another workspace', async () => {
    const { client } = clientFor({
      reservations: [reservation()],
      properties: [
        { id: 'property-1', account_id: 'account-2', name: 'Secret Villa' },
      ],
    });
    const stays = await loadContactStays(client, {
      accountId: ACCOUNT,
      contactId: CONTACT,
      today: TODAY,
    });
    expect(stays[0]?.propertyName).toBeNull();
  });
});
