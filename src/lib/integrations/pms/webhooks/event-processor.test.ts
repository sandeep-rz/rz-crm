import { describe, expect, it, vi } from 'vitest';

import {
  PmsProviderError,
  type PmsProvider,
  type PmsReservation,
} from '../provider';
import {
  syncPmsReservation,
  type PmsContactRecord,
  type PmsReservationSyncStore,
} from '../reservation-sync';
import {
  PMS_WEBHOOK_EVENT_STALE_MS,
  processPmsWebhookEvent,
  runPmsWebhookEventWorker,
  type PmsWebhookEventClaim,
  type PmsWebhookEventContext,
  type PmsWebhookEventStore,
} from './event-processor';

const NOW = new Date('2026-09-28T12:00:00.000Z');

const reservation: PmsReservation = {
  externalId: 'reservation-1',
  sourceType: 'pms_bookings',
  externalPropertyId: '22008',
  externalListingId: 'listing-1',
  reservationCode: 'RZ-1',
  status: 'confirmed',
  providerStatus: 'confirmed',
  checkIn: '2026-10-01',
  checkOut: '2026-10-03',
  guest: {
    externalId: 'guest-1',
    fullName: 'Guest One',
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
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-28T11:00:00.000Z',
};

const claim: PmsWebhookEventClaim = {
  id: 'event-row-1',
  provider: 'rukiye_zara',
  externalEventId: 'event-1',
  accountId: 'account-1',
  integrationId: 'integration-1',
  propertyId: 'property-1',
  eventType: 'reservation.confirmed',
  externalResourceId: reservation.externalId,
  occurredAt: '2026-09-28T11:00:00.000Z',
  processingStartedAt: NOW.toISOString(),
  attemptCount: 1,
};

const context: PmsWebhookEventContext = {
  integration: {
    integrationId: claim.integrationId,
    accountId: claim.accountId,
    provider: claim.provider,
    externalAccountId: 'external-account-1',
  },
  property: {
    id: claim.propertyId,
    accountId: claim.accountId,
    integrationId: claim.integrationId,
    externalPropertyId: reservation.externalPropertyId,
  },
};

class MemoryEventStore implements PmsWebhookEventStore {
  queue: PmsWebhookEventClaim[] = [];
  context: PmsWebhookEventContext | null = { ...context };
  processed: string[] = [];
  ignored: string[] = [];
  failures = new Map<
    string,
    { error: string; retryable: boolean; nextAttemptAt: string | null }
  >();
  claimInputs: Array<{ limit: number; now: string; staleBefore: string }> = [];

  async claimEvents(input: {
    limit: number;
    now: string;
    staleBefore: string;
  }) {
    this.claimInputs.push(input);
    return this.queue.splice(0, input.limit);
  }

  async loadContext() {
    return this.context;
  }

  async markProcessed(event: PmsWebhookEventClaim) {
    this.processed.push(event.id);
  }

  async markIgnored(event: PmsWebhookEventClaim) {
    this.ignored.push(event.id);
  }

  async markFailed(
    event: PmsWebhookEventClaim,
    input: {
      error: string;
      retryable: boolean;
      nextAttemptAt: string | null;
    }
  ) {
    this.failures.set(event.id, input);
  }
}

class MemoryReservationStore implements PmsReservationSyncStore {
  contacts: PmsContactRecord[] = [];
  guestMappings = new Map<string, string>();
  reservations = new Map<
    string,
    {
      id: string;
      externalUpdatedAt: string | null;
      reservation: PmsReservation;
      contactId: string | null;
    }
  >();

  async findGuestMapping(input: {
    integrationId: string;
    externalGuestId: string;
  }) {
    const contactId = this.guestMappings.get(
      `${input.integrationId}:${input.externalGuestId}`
    );
    return contactId ? { contactId } : null;
  }

  async findContactsByPhone(_accountId: string, phone: string) {
    return this.contacts.filter(
      (contact) => contact.phone.replace(/\D/g, '') === phone
    );
  }

  async findContactsByEmail(_accountId: string, email: string) {
    return this.contacts.filter(
      (contact) => contact.email?.toLowerCase() === email
    );
  }

  async findContactById(_accountId: string, contactId: string) {
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
      id: `contact-${this.contacts.length + 1}`,
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
    if (!this.guestMappings.has(key)) {
      this.guestMappings.set(key, input.contactId);
    }
    return { contactId: this.guestMappings.get(key)! };
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
    void input.syncedAt;
    const key = `${input.integrationId}:${input.reservation.externalId}`;
    const id = input.existing?.id ?? `projection-${this.reservations.size + 1}`;
    this.reservations.set(key, {
      id,
      externalUpdatedAt: input.reservation.updatedAt,
      reservation: input.reservation,
      contactId: input.contactId,
    });
    return { id, skippedStale: false };
  }
}

function providerFor(value: PmsReservation | Error) {
  const getReservation = vi.fn(async () => {
    if (value instanceof Error) throw value;
    return value;
  });
  const provider = {
    provider: 'rukiye_zara',
    getProperty: vi.fn(),
    listReservations: vi.fn(),
    getReservation,
  } as unknown as PmsProvider;
  return { provider, getReservation };
}

function dependencies(
  store: MemoryEventStore,
  reservations: MemoryReservationStore,
  provider: PmsProvider
) {
  return {
    store,
    reservationStore: reservations,
    createProvider: () => provider,
    now: () => new Date(NOW),
  };
}

describe('PMS webhook event processor', () => {
  it('fetches and processes reservation.confirmed from the canonical provider', async () => {
    const events = new MemoryEventStore();
    const projections = new MemoryReservationStore();
    const canonical = providerFor(reservation);

    const result = await processPmsWebhookEvent(
      claim,
      dependencies(events, projections, canonical.provider)
    );

    expect(result.status).toBe('processed');
    expect(canonical.getReservation).toHaveBeenCalledWith({
      integration: context.integration,
      externalPropertyId: '22008',
      externalReservationId: 'reservation-1',
    });
    expect(events.processed).toEqual([claim.id]);
    expect(
      projections.reservations.get('integration-1:reservation-1')
    ).toMatchObject({ reservation: { status: 'confirmed' } });
  });

  it('updates an existing reservation from reservation.updated', async () => {
    const events = new MemoryEventStore();
    const projections = new MemoryReservationStore();
    const first = providerFor(reservation);
    await processPmsWebhookEvent(
      claim,
      dependencies(events, projections, first.provider)
    );

    const updated: PmsReservation = {
      ...reservation,
      status: 'confirmed',
      providerStatus: 'modified',
      updatedAt: '2026-09-28T11:30:00.000Z',
    };
    const canonical = providerFor(updated);
    await processPmsWebhookEvent(
      { ...claim, id: 'event-row-2', eventType: 'reservation.updated' },
      dependencies(events, projections, canonical.provider)
    );

    expect(projections.reservations).toHaveLength(1);
    expect(
      projections.reservations.get('integration-1:reservation-1')
    ).toMatchObject({
      reservation: { status: 'confirmed', providerStatus: 'modified' },
    });
  });

  it('retains and updates a cancelled reservation instead of deleting it', async () => {
    const events = new MemoryEventStore();
    const projections = new MemoryReservationStore();
    const canonical = providerFor({ ...reservation, status: 'cancelled' });

    await processPmsWebhookEvent(
      { ...claim, eventType: 'reservation.cancelled' },
      dependencies(events, projections, canonical.provider)
    );

    expect(projections.reservations).toHaveLength(1);
    expect(
      projections.reservations.get('integration-1:reservation-1')
    ).toMatchObject({ reservation: { status: 'cancelled' } });
  });

  it('allows only one of two overlapping workers to claim the event', async () => {
    const events = new MemoryEventStore();
    events.queue.push(claim);
    const projections = new MemoryReservationStore();
    const canonical = providerFor(reservation);

    const results = await Promise.all([
      runPmsWebhookEventWorker(
        dependencies(events, projections, canonical.provider)
      ),
      runPmsWebhookEventWorker(
        dependencies(events, projections, canonical.provider)
      ),
    ]);

    expect(results.reduce((total, item) => total + item.claimed, 0)).toBe(1);
    expect(canonical.getReservation).toHaveBeenCalledOnce();
    expect(projections.reservations).toHaveLength(1);
  });

  it('reuses the contact created by initial sync for the same stable guest', async () => {
    const projections = new MemoryReservationStore();
    const initial = await syncPmsReservation(
      {
        accountId: claim.accountId,
        integration: context.integration,
        property: { id: claim.propertyId, externalPropertyId: '22008' },
        reservation,
      },
      projections
    );
    const events = new MemoryEventStore();
    const webhookReservation = {
      ...reservation,
      externalId: 'reservation-2',
      reservationCode: 'RZ-2',
    };
    const canonical = providerFor(webhookReservation);

    await processPmsWebhookEvent(
      { ...claim, externalResourceId: 'reservation-2' },
      dependencies(events, projections, canonical.provider)
    );

    expect(projections.contacts).toHaveLength(1);
    expect(
      projections.reservations.get('integration-1:reservation-2')?.contactId
    ).toBe(initial.contactId);
  });

  it('schedules bounded backoff for temporary provider failures', async () => {
    const events = new MemoryEventStore();
    const canonical = providerFor(
      new PmsProviderError('rate_limited', 'secret-bearing upstream detail')
    );

    const result = await processPmsWebhookEvent(
      claim,
      dependencies(events, new MemoryReservationStore(), canonical.provider)
    );

    expect(result).toMatchObject({ status: 'failed', retryable: true });
    expect(events.failures.get(claim.id)).toEqual({
      error: 'provider_rate_limited: PMS canonical reservation fetch failed.',
      retryable: true,
      nextAttemptAt: '2026-09-28T12:01:00.000Z',
    });

    await processPmsWebhookEvent(
      { ...claim, id: 'last-attempt', attemptCount: 5 },
      dependencies(events, new MemoryReservationStore(), canonical.provider)
    );
    expect(events.failures.get('last-attempt')).toMatchObject({
      retryable: false,
      nextAttemptAt: null,
    });
  });

  it('records permanent provider failures without leaking provider details', async () => {
    const events = new MemoryEventStore();
    const secret = 'never-return-this-secret';
    const canonical = providerFor(
      new PmsProviderError('access_denied', `denied ${secret}`)
    );

    const result = await processPmsWebhookEvent(
      claim,
      dependencies(events, new MemoryReservationStore(), canonical.provider)
    );
    const failure = events.failures.get(claim.id)!;

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(failure.error).not.toContain(secret);
    expect(failure.nextAttemptAt).toBeNull();
  });

  it('passes the stale-processing recovery boundary to the atomic claim', async () => {
    const events = new MemoryEventStore();
    events.queue.push({ ...claim, attemptCount: 2 });
    const canonical = providerFor(reservation);

    await runPmsWebhookEventWorker(
      dependencies(events, new MemoryReservationStore(), canonical.provider)
    );

    expect(events.claimInputs[0]).toEqual({
      limit: 10,
      now: NOW.toISOString(),
      staleBefore: new Date(
        NOW.getTime() - PMS_WEBHOOK_EVENT_STALE_MS
      ).toISOString(),
    });
  });

  it('ignores unsupported events without mutating reservations', async () => {
    const events = new MemoryEventStore();
    const projections = new MemoryReservationStore();
    const canonical = providerFor(reservation);

    const result = await processPmsWebhookEvent(
      { ...claim, eventType: 'reservation.deleted_forever' },
      dependencies(events, projections, canonical.provider)
    );

    expect(result.status).toBe('ignored');
    expect(events.ignored).toEqual([claim.id]);
    expect(canonical.getReservation).not.toHaveBeenCalled();
    expect(projections.reservations).toHaveLength(0);
  });

  it('permanently rejects an account, integration, or property mismatch', async () => {
    const events = new MemoryEventStore();
    events.context = {
      ...context,
      property: { ...context.property, integrationId: 'integration-other' },
    };
    const canonical = providerFor(reservation);

    const result = await processPmsWebhookEvent(
      claim,
      dependencies(events, new MemoryReservationStore(), canonical.provider)
    );

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(events.failures.get(claim.id)?.error).toContain('invalid_mapping');
    expect(canonical.getReservation).not.toHaveBeenCalled();
  });

  it('continues processing the batch after one event fails', async () => {
    const events = new MemoryEventStore();
    events.queue.push(
      { ...claim, id: 'bad', externalResourceId: null },
      { ...claim, id: 'good' }
    );
    const canonical = providerFor(reservation);

    const result = await runPmsWebhookEventWorker(
      dependencies(events, new MemoryReservationStore(), canonical.provider)
    );

    expect(result).toEqual({ claimed: 2, processed: 1, failed: 1, ignored: 0 });
    expect(events.processed).toEqual(['good']);
  });
});
