import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildMessageContext,
  MessageContextError,
  nightsBetween,
  splitCanonicalContactName,
} from './context';

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  return {
    calls,
    client: {
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            return builder;
          },
          async maybeSingle() {
            calls.push({ table, filters: [...filters] });
            const matches = (seed[table] ?? []).filter((row) =>
              filters.every(([column, value]) => row[column] === value)
            );
            return { data: matches[0] ?? null, error: null };
          },
        };
        return builder;
      },
    } as unknown as SupabaseClient,
  };
}

const workspace = { id: 'account-a', name: 'Workspace A' };
const contact = {
  id: 'contact-a',
  account_id: 'account-a',
  name: 'Sandeep Kumar Sharma',
  phone: '+910000000000',
  email: 'private@example.com',
};
const property = {
  id: 'property-a',
  account_id: 'account-a',
  name: 'Lakeside Meadows',
  timezone: 'Asia/Kolkata',
};
const communicationSettings = {
  id: 'settings-a',
  account_id: 'account-a',
  pms_property_id: 'property-a',
  map_url: 'https://maps.example/lakeside',
  checkin_method: 'Self check-in',
  directions: 'Turn left at the lake',
  parking_instructions: 'Park beside the gate',
  nearby_landmark: 'Lakeside Café',
  caretaker_name: 'Anil',
  caretaker_phone: '+919876543210',
  emergency_phone: '+919876543211',
  wifi_name: 'LakesideGuest',
  wifi_password: 'private-password',
  house_manual: 'Read the printed guide',
  checkout_instructions: 'Return the key at reception',
};
const reservation = {
  id: 'reservation-a',
  account_id: 'account-a',
  pms_property_id: 'property-a',
  contact_id: 'contact-a',
  reservation_code: 'ABC123',
  status: 'confirmed',
  check_in: '2026-10-15',
  check_out: '2026-10-18',
  adults: 2,
  children: 1,
  infants: 1,
  occupancy_total: 4,
  channel_code: 'direct',
  channel_name: 'Direct',
  total_amount: '12500.50',
  currency: 'INR',
};

function baseSeed(overrides: Record<string, Row[]> = {}) {
  return {
    accounts: [workspace],
    contacts: [contact],
    pms_properties: [property],
    pms_reservations: [reservation],
    property_communication_settings: [],
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((caught) => caught);
  expect(error).toBeInstanceOf(MessageContextError);
  expect((error as MessageContextError).code).toBe(code);
}

describe('buildMessageContext', () => {
  it('builds contact-only context with its workspace', async () => {
    const { client } = fakeDb(baseSeed());
    const result = await buildMessageContext(
      { accountId: 'account-a', contactId: 'contact-a' },
      client
    );
    expect(result.contact).toMatchObject({
      id: 'contact-a',
      first_name: 'Sandeep',
      last_name: 'Kumar Sharma',
      full_name: 'Sandeep Kumar Sharma',
    });
    expect(result.workspace).toEqual(workspace);
    expect(result.reservation).toBeUndefined();
    expect(result.property).toBeUndefined();
  });

  it('normalizes a blank workspace name to unknown without inventing a fallback', async () => {
    const { client } = fakeDb(
      baseSeed({ accounts: [{ id: 'account-a', name: '   ' }] })
    );
    const result = await buildMessageContext(
      { accountId: 'account-a' },
      client
    );
    expect(result.workspace).toEqual({ id: 'account-a', name: null });
  });

  it('includes canonical reservation, associated property, and associated contact', async () => {
    const { client } = fakeDb(baseSeed());
    const result = await buildMessageContext(
      { accountId: 'account-a', reservationId: 'reservation-a' },
      client
    );
    expect(result.reservation).toEqual({
      id: 'reservation-a',
      reference: 'ABC123',
      status: 'confirmed',
      check_in: '2026-10-15',
      check_out: '2026-10-18',
      nights: 3,
      guest_count: 4,
      adult_count: 2,
      child_count: 1,
      channel: 'Direct',
      amount: '12500.50',
      currency: 'INR',
    });
    expect(result.property).toMatchObject({
      id: 'property-a',
      name: 'Lakeside Meadows',
      map_url: null,
      wifi_password: null,
    });
    expect(result.contact?.id).toBe('contact-a');
  });

  it('rejects a contact owned by another account', async () => {
    const { client } = fakeDb(
      baseSeed({ contacts: [{ ...contact, account_id: 'account-b' }] })
    );
    await expectCode(
      buildMessageContext(
        { accountId: 'account-a', contactId: 'contact-a' },
        client
      ),
      'entity_not_found'
    );
  });

  it('rejects a reservation owned by another account', async () => {
    const { client } = fakeDb(
      baseSeed({
        pms_reservations: [{ ...reservation, account_id: 'account-b' }],
      })
    );
    await expectCode(
      buildMessageContext(
        { accountId: 'account-a', reservationId: 'reservation-a' },
        client
      ),
      'entity_not_found'
    );
  });

  it('rejects a property owned by another account', async () => {
    const { client } = fakeDb(
      baseSeed({
        pms_properties: [{ ...property, account_id: 'account-b' }],
      })
    );
    await expectCode(
      buildMessageContext(
        { accountId: 'account-a', propertyId: 'property-a' },
        client
      ),
      'entity_not_found'
    );
  });

  it('loads communication settings only for the canonical property and account', async () => {
    const { client, calls } = fakeDb(
      baseSeed({ property_communication_settings: [communicationSettings] })
    );
    const result = await buildMessageContext(
      { accountId: 'account-a', propertyId: 'property-a' },
      client
    );
    expect(result.property).toMatchObject({
      id: 'property-a',
      name: 'Lakeside Meadows',
      map_url: 'https://maps.example/lakeside',
      checkin_method: 'Self check-in',
      caretaker_name: 'Anil',
      caretaker_phone: '+919876543210',
      wifi_name: 'LakesideGuest',
      wifi_password: 'private-password',
      house_manual: 'Read the printed guide',
    });
    expect(calls).toContainEqual({
      table: 'property_communication_settings',
      filters: [
        ['pms_property_id', 'property-a'],
        ['account_id', 'account-a'],
      ],
    });
  });

  it('does not leak settings from another property or account', async () => {
    const { client } = fakeDb(
      baseSeed({
        property_communication_settings: [
          { ...communicationSettings, pms_property_id: 'property-b' },
          { ...communicationSettings, account_id: 'account-b' },
        ],
      })
    );
    const result = await buildMessageContext(
      { accountId: 'account-a', propertyId: 'property-a' },
      client
    );
    expect(result.property?.map_url).toBeNull();
    expect(result.property?.caretaker_phone).toBeNull();
    expect(result.property?.wifi_password).toBeNull();
  });

  it('keeps canonical property name behavior and leaves timezone in pms_properties', async () => {
    const { client } = fakeDb(baseSeed());
    const result = await buildMessageContext(
      { accountId: 'account-a', propertyId: 'property-a' },
      client
    );
    expect(result.property?.name).toBe('Lakeside Meadows');
    expect(result.property).not.toHaveProperty('timezone');
  });

  it('rejects conflicting reservation and property ids', async () => {
    const { client } = fakeDb(baseSeed());
    await expectCode(
      buildMessageContext(
        {
          accountId: 'account-a',
          reservationId: 'reservation-a',
          propertyId: 'property-b',
        },
        client
      ),
      'relationship_conflict'
    );
  });

  it('rejects conflicting reservation and contact ids', async () => {
    const { client } = fakeDb(baseSeed());
    await expectCode(
      buildMessageContext(
        {
          accountId: 'account-a',
          reservationId: 'reservation-a',
          contactId: 'contact-b',
        },
        client
      ),
      'relationship_conflict'
    );
  });

  it('does not fuzzy-match a reservation without a persisted contact association', async () => {
    const { client, calls } = fakeDb(
      baseSeed({
        pms_reservations: [{ ...reservation, contact_id: null }],
      })
    );
    const result = await buildMessageContext(
      { accountId: 'account-a', reservationId: 'reservation-a' },
      client
    );
    expect(result.contact).toBeUndefined();
    expect(calls.some((call) => call.table === 'contacts')).toBe(false);
  });

  it('rejects an explicit contact when the reservation has no contact association', async () => {
    const { client } = fakeDb(
      baseSeed({
        pms_reservations: [{ ...reservation, contact_id: null }],
      })
    );
    await expectCode(
      buildMessageContext(
        {
          accountId: 'account-a',
          reservationId: 'reservation-a',
          contactId: 'contact-a',
        },
        client
      ),
      'relationship_conflict'
    );
  });

  it('keeps decimal amount as an unformatted string', async () => {
    const { client } = fakeDb(baseSeed());
    const result = await buildMessageContext(
      { accountId: 'account-a', reservationId: 'reservation-a' },
      client
    );
    expect(result.reservation?.amount).toBe('12500.50');
    expect(typeof result.reservation?.amount).toBe('string');
  });

  it('contains no provider-specific keys', async () => {
    const { client } = fakeDb(baseSeed());
    const result = await buildMessageContext(
      { accountId: 'account-a', reservationId: 'reservation-a' },
      client
    );
    expect(JSON.stringify(result)).not.toMatch(/rukiye|channex|pms_|provider/i);
  });
});

describe('message context computed values', () => {
  it('splits missing and single-part names without placeholder text', () => {
    expect(splitCanonicalContactName(null)).toEqual({
      firstName: null,
      lastName: null,
      fullName: null,
    });
    expect(splitCanonicalContactName('Madonna')).toEqual({
      firstName: 'Madonna',
      lastName: null,
      fullName: 'Madonna',
    });
  });

  it('computes nights from canonical dates and rejects inverted dates', () => {
    expect(nightsBetween('2026-10-15', '2026-10-18')).toBe(3);
    expect(nightsBetween('2026-10-18', '2026-10-15')).toBeNull();
  });
});
