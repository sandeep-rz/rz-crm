import { describe, expect, it } from 'vitest';

import type { PmsReservation } from './provider';
import {
  syncPmsReservation,
  type PmsContactRecord,
  type PmsReservationSyncStore,
} from './reservation-sync';

const integration = {
  integrationId: 'integration-a',
  accountId: 'account-a',
  provider: 'rukiye_zara',
  externalAccountId: 'pms-account',
};
const property = { id: 'property-a', externalPropertyId: '22008' };
const reservation: PmsReservation = {
  externalId: 'reservation-a',
  sourceType: 'pms_bookings',
  externalPropertyId: '22008',
  externalListingId: 'listing-a',
  reservationCode: 'RZ-A',
  status: 'confirmed',
  providerStatus: 'confirmed',
  checkIn: '2026-10-01',
  checkOut: '2026-10-03',
  guest: {
    externalId: 'guest-a',
    fullName: 'Guest A',
    email: 'guest@example.com',
    phone: '+14155550123',
  },
  occupancy: { adults: 2, children: 0, infants: 0, pets: 0, total: 2 },
  channel: { code: 'direct', name: 'Direct' },
  financial: {
    totalAmount: 100,
    paidAmount: 50,
    balanceDue: 50,
    currency: 'INR',
    paymentStatus: 'partial',
  },
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
};

function store(overrides: Partial<MemoryStore> = {}) {
  return new MemoryStore(overrides);
}

class MemoryStore implements PmsReservationSyncStore {
  contacts: PmsContactRecord[] = [];
  mappings = new Map<string, string>();
  reservations = new Map<
    string,
    { id: string; externalUpdatedAt: string | null }
  >();
  nextContact = 1;
  nextReservation = 1;
  constructor(overrides: Partial<MemoryStore> = {}) {
    Object.assign(this, overrides);
  }
  async findGuestMapping(input: {
    integrationId: string;
    externalGuestId: string;
  }) {
    const id = this.mappings.get(
      `${input.integrationId}:${input.externalGuestId}`
    );
    return id ? { contactId: id } : null;
  }
  async findContactsByPhone(accountId: string, phone: string) {
    void accountId;
    return this.contacts.filter(
      (contact) => contact.phone.replace(/\D/g, '') === phone
    );
  }
  async findContactsByEmail(accountId: string, email: string) {
    void accountId;
    return this.contacts.filter(
      (contact) => contact.email?.toLowerCase() === email
    );
  }
  async findContactById(accountId: string, contactId: string) {
    void accountId;
    return this.contacts.find((contact) => contact.id === contactId) ?? null;
  }
  async createContact(input: {
    accountId: string;
    phone: string;
    name: string | null;
    email: string | null;
  }) {
    void input.accountId;
    const contact = {
      id: `contact-${this.nextContact++}`,
      phone: input.phone,
      name: input.name,
      email: input.email,
    };
    this.contacts.push(contact);
    return { contact, created: true };
  }
  async enrichContact(input: {
    accountId: string;
    contact: PmsContactRecord;
    phone: string | null;
    name: string | null;
    email: string | null;
  }) {
    void input.accountId;
    if (!input.contact.phone && input.phone) input.contact.phone = input.phone;
    if (!input.contact.name && input.name) input.contact.name = input.name;
    if (!input.contact.email && input.email) input.contact.email = input.email;
    return input.contact;
  }
  async createGuestMapping(input: {
    accountId: string;
    integrationId: string;
    contactId: string;
    externalGuestId: string;
  }) {
    void input.accountId;
    const key = `${input.integrationId}:${input.externalGuestId}`;
    if (!this.mappings.has(key)) this.mappings.set(key, input.contactId);
    return { contactId: this.mappings.get(key)! };
  }
  async findReservation(input: {
    accountId: string;
    integrationId: string;
    externalReservationId: string;
  }) {
    void input.accountId;
    return (
      this.reservations.get(
        `${input.integrationId}:${input.externalReservationId}`
      ) ?? null
    );
  }
  async saveReservation(input: {
    accountId: string;
    integrationId: string;
    propertyId: string;
    contactId: string | null;
    reservation: PmsReservation;
    syncedAt: string;
    existing: { id: string; externalUpdatedAt: string | null } | null;
  }) {
    void input.accountId;
    void input.propertyId;
    void input.contactId;
    void input.syncedAt;
    if (
      input.existing?.externalUpdatedAt &&
      input.reservation.updatedAt &&
      input.existing.externalUpdatedAt > input.reservation.updatedAt
    ) {
      return { id: input.existing.id, skippedStale: true };
    }
    const key = `${input.integrationId}:${input.reservation.externalId}`;
    const record = input.existing ?? {
      id: `reservation-${this.nextReservation++}`,
      externalUpdatedAt: null,
    };
    this.reservations.set(key, {
      id: record.id,
      externalUpdatedAt: input.reservation.updatedAt,
    });
    return { id: record.id, skippedStale: false };
  }
}

describe('syncPmsReservation contact and projection pipeline', () => {
  it('reuses an existing stable guest mapping', async () => {
    const db = store();
    db.mappings.set('integration-a:guest-a', 'contact-existing');
    const result = await syncPmsReservation(
      { accountId: 'account-a', integration, property, reservation },
      db
    );
    expect(result.contactId).toBe('contact-existing');
    expect(db.contacts).toHaveLength(0);
  });

  it('matches by normalized phone, then creates a stable mapping', async () => {
    const db = store({
      contacts: [
        {
          id: 'contact-phone',
          phone: '+14155550123',
          name: 'Existing',
          email: null,
        },
      ],
    });
    const result = await syncPmsReservation(
      { accountId: 'account-a', integration, property, reservation },
      db
    );
    expect(result.contactId).toBe('contact-phone');
    expect(db.mappings.get('integration-a:guest-a')).toBe('contact-phone');
  });

  it('falls back to safe email and never matches by name', async () => {
    const db = store({
      contacts: [
        {
          id: 'contact-email',
          phone: '+14155550124',
          name: 'Different Name',
          email: 'guest@example.com',
        },
      ],
    });
    const result = await syncPmsReservation(
      {
        accountId: 'account-a',
        integration,
        property,
        reservation: {
          ...reservation,
          guest: { ...reservation.guest, phone: null },
        },
      },
      db
    );
    expect(result.contactId).toBe('contact-email');
    const byName = await syncPmsReservation(
      {
        accountId: 'account-a',
        integration,
        property,
        reservation: {
          ...reservation,
          guest: {
            ...reservation.guest,
            externalId: null,
            phone: null,
            email: null,
          },
        },
      },
      store()
    );
    expect(byName.contactId).toBeNull();
  });

  it('creates phone-less contacts from stable identity or safe email and enriches without overwriting', async () => {
    const db = store({
      contacts: [
        {
          id: 'contact-rich',
          phone: '+14155550123',
          name: 'CRM Name',
          email: 'crm@example.com',
        },
      ],
    });
    await syncPmsReservation(
      { accountId: 'account-a', integration, property, reservation },
      db
    );
    expect(db.contacts[0]).toMatchObject({
      name: 'CRM Name',
      email: 'crm@example.com',
    });
    const noPhone = await syncPmsReservation(
      {
        accountId: 'account-a',
        integration,
        property,
        reservation: {
          ...reservation,
          externalId: 'no-phone',
          guest: { ...reservation.guest, externalId: null, phone: null },
        },
      },
      db
    );
    expect(noPhone.contactId).not.toBeNull();
    expect(db.contacts.at(-1)).toMatchObject({
      phone: '',
      email: 'guest@example.com',
    });

    const stableOnly = await syncPmsReservation(
      {
        accountId: 'account-a',
        integration,
        property,
        reservation: {
          ...reservation,
          externalId: 'stable-only',
          guest: {
            externalId: 'guest-without-phone',
            fullName: 'Phone-less Guest',
            phone: null,
            email: null,
          },
        },
      },
      db
    );
    expect(stableOnly.contactId).not.toBeNull();
    expect(db.contacts.at(-1)?.phone).toBe('');
    expect(db.mappings.get('integration-a:guest-without-phone')).toBe(
      stableOnly.contactId
    );
  });

  it('does not arbitrarily merge ambiguous phone or email identities', async () => {
    const phoneAmbiguous = store({
      contacts: [
        { id: 'phone-1', phone: '+14155550123', name: 'One', email: null },
        { id: 'phone-2', phone: '+14155550123', name: 'Two', email: null },
      ],
    });
    const phoneResult = await syncPmsReservation(
      {
        accountId: 'account-a',
        integration,
        property,
        reservation: {
          ...reservation,
          externalId: 'ambiguous-phone',
          guest: { ...reservation.guest, externalId: null, email: null },
        },
      },
      phoneAmbiguous
    );
    expect(phoneResult.contactId).not.toBe('phone-1');
    expect(phoneResult.contactId).not.toBe('phone-2');

    const emailAmbiguous = store({
      contacts: [
        {
          id: 'email-1',
          phone: '+14155550124',
          name: 'One',
          email: 'same@example.com',
        },
        {
          id: 'email-2',
          phone: '+14155550125',
          name: 'Two',
          email: 'same@example.com',
        },
      ],
    });
    const emailResult = await syncPmsReservation(
      {
        accountId: 'account-a',
        integration,
        property,
        reservation: {
          ...reservation,
          externalId: 'ambiguous-email',
          guest: {
            ...reservation.guest,
            externalId: null,
            phone: null,
            email: 'same@example.com',
          },
        },
      },
      emailAmbiguous
    );
    expect(emailResult.contactId).toBeNull();
  });

  it('does not create an external mapping when the provider guest id is null', async () => {
    const db = store();
    await syncPmsReservation(
      {
        accountId: 'account-a',
        integration,
        property,
        reservation: {
          ...reservation,
          externalId: 'null-guest',
          guest: { ...reservation.guest, externalId: null },
        },
      },
      db
    );
    expect(db.mappings.size).toBe(0);
  });

  it('does not cross integrations and rejects a property mismatch', async () => {
    const db = store();
    const other = { ...integration, integrationId: 'integration-b' };
    await syncPmsReservation(
      { accountId: 'account-a', integration: other, property, reservation },
      db
    );
    expect(db.mappings.has('integration-b:guest-a')).toBe(true);
    await expect(
      syncPmsReservation(
        {
          accountId: 'account-a',
          integration,
          property,
          reservation: { ...reservation, externalPropertyId: 'other' },
        },
        db
      )
    ).rejects.toThrow(/different PMS property/);
  });

  it('keeps duplicate reservations idempotent and preserves richer CRM data', async () => {
    const db = store();
    const first = await syncPmsReservation(
      { accountId: 'account-a', integration, property, reservation },
      db
    );
    const second = await syncPmsReservation(
      { accountId: 'account-a', integration, property, reservation },
      db
    );
    expect(second.reservationId).toBe(first.reservationId);
    expect(db.reservations.size).toBe(1);
  });

  it('does not regress a newer stored projection', async () => {
    const db = store({
      reservations: new Map([
        [
          'integration-a:reservation-a',
          { id: 'saved', externalUpdatedAt: '2026-09-03T00:00:00Z' },
        ],
      ]),
    });
    const result = await syncPmsReservation(
      { accountId: 'account-a', integration, property, reservation },
      db
    );
    expect(result.skippedStale).toBe(true);
  });
});
