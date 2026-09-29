import { describe, expect, it, vi } from 'vitest';

import {
  PmsProviderError,
  type PmsProvider,
  type PmsReservation,
  type PmsReservationPage,
} from './provider';
import {
  PMS_RECONCILIATION_INTERVAL_MS,
  PMS_RECONCILIATION_PAGE_SIZE,
  PMS_RECONCILIATION_STALE_MS,
  SupabasePmsReconciliationStore,
  runPmsReservationReconciliationWorker,
  type PmsReconciliationClaim,
  type PmsReconciliationStore,
} from './reconciliation';
import type {
  PmsContactRecord,
  PmsReservationSyncStore,
} from './reservation-sync';
import {
  processPmsWebhookEvent,
  type PmsWebhookEventClaim,
  type PmsWebhookEventStore,
} from './webhooks/event-processor';

const NOW = new Date('2026-09-28T12:00:00.000Z');

const claim: PmsReconciliationClaim = {
  propertyId: 'property-1',
  accountId: 'account-1',
  externalPropertyId: '22008',
  lastReconciledAt: null,
  integration: {
    integrationId: 'integration-1',
    accountId: 'account-1',
    provider: 'rukiye_zara',
    externalAccountId: 'pms-account-1',
  },
  processingStartedAt: NOW.toISOString(),
  attemptCount: 1,
};

function reservation(
  id: string,
  overrides: Partial<PmsReservation> = {}
): PmsReservation {
  const base: PmsReservation = {
    externalId: id,
    sourceType: 'pms_bookings',
    externalPropertyId: '22008',
    externalListingId: 'listing-1',
    reservationCode: `RZ-${id}`,
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
  return {
    ...base,
    ...overrides,
    status: overrides.status ?? base.status,
    providerStatus: overrides.providerStatus ?? base.providerStatus,
    guest: { ...base.guest, ...overrides.guest },
    occupancy: { ...base.occupancy, ...overrides.occupancy },
    channel: { ...base.channel, ...overrides.channel },
    financial: { ...base.financial, ...overrides.financial },
  };
}

interface ReconciliationRow {
  claim: PmsReconciliationClaim;
  active: boolean;
  connected: boolean;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  startedAt: string | null;
  lastReconciledAt: string | null;
  nextAttemptAt: string | null;
  error: string | null;
}

class MemoryReconciliationStore implements PmsReconciliationStore {
  rows: ReconciliationRow[];

  constructor(
    row: Partial<ReconciliationRow> = {},
    baseClaim: PmsReconciliationClaim = claim
  ) {
    this.rows = [
      {
        claim: { ...baseClaim },
        active: true,
        connected: true,
        status: 'pending',
        startedAt: null,
        lastReconciledAt: null,
        nextAttemptAt: null,
        error: null,
        ...row,
      },
    ];
  }

  async claimProperties(input: {
    limit: number;
    now: string;
    dueBefore: string;
    staleBefore: string;
  }) {
    const claimed: PmsReconciliationClaim[] = [];
    for (const row of this.rows) {
      const stale =
        row.status === 'processing' &&
        (!row.startedAt || row.startedAt <= input.staleBefore);
      const due =
        row.status !== 'processing' &&
        (!row.nextAttemptAt || row.nextAttemptAt <= input.now) &&
        (!row.lastReconciledAt || row.lastReconciledAt <= input.dueBefore);
      if (!row.active || !row.connected || (!stale && !due)) continue;
      if (claimed.length >= input.limit) break;
      row.status = 'processing';
      row.startedAt = input.now;
      row.error = null;
      row.nextAttemptAt = null;
      row.claim = {
        ...row.claim,
        lastReconciledAt: row.lastReconciledAt,
        processingStartedAt: input.now,
        attemptCount: row.claim.attemptCount + 1,
      };
      claimed.push({ ...row.claim });
    }
    return claimed;
  }

  async markCompleted(current: PmsReconciliationClaim, completedAt: string) {
    const row = this.rowForLease(current);
    row.status = 'completed';
    row.startedAt = null;
    row.lastReconciledAt = completedAt;
    row.nextAttemptAt = null;
    row.error = null;
  }

  async markFailed(
    current: PmsReconciliationClaim,
    input: { error: string; nextAttemptAt: string }
  ) {
    const row = this.rowForLease(current);
    row.status = 'failed';
    row.startedAt = null;
    row.error = input.error;
    row.nextAttemptAt = input.nextAttemptAt;
  }

  private rowForLease(current: PmsReconciliationClaim) {
    const row = this.rows.find(
      (candidate) => candidate.claim.propertyId === current.propertyId
    );
    if (
      !row ||
      row.status !== 'processing' ||
      row.claim.attemptCount !== current.attemptCount
    ) {
      throw new Error('lease lost');
    }
    return row;
  }
}

class MemoryReservationStore implements PmsReservationSyncStore {
  contacts: PmsContactRecord[] = [];
  mappings = new Map<string, string>();
  reservations = new Map<
    string,
    {
      id: string;
      externalUpdatedAt: string | null;
      status: string;
      contactId: string | null;
    }
  >();

  async findGuestMapping(input: {
    integrationId: string;
    externalGuestId: string;
  }) {
    const contactId = this.mappings.get(
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
    const existing = this.contacts.find(
      (contact) =>
        (!!input.phone && contact.phone === input.phone) ||
        (!!input.email && contact.email?.toLowerCase() === input.email)
    );
    if (existing) return { contact: existing, created: false };
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
    void input.syncedAt;
    const key = `${input.integrationId}:${input.reservation.externalId}`;
    const winner = this.reservations.get(key);
    const current = input.existing ?? winner;
    if (
      current?.externalUpdatedAt &&
      (!input.reservation.updatedAt ||
        current.externalUpdatedAt > input.reservation.updatedAt)
    ) {
      return { id: current.id, skippedStale: true };
    }
    const id = current?.id ?? `reservation-${this.reservations.size + 1}`;
    this.reservations.set(key, {
      id,
      externalUpdatedAt: input.reservation.updatedAt,
      status: input.reservation.status,
      contactId: input.contactId,
    });
    return { id, skippedStale: false };
  }
}

function provider(pages: Array<PmsReservationPage | Error>): PmsProvider {
  let index = 0;
  return {
    provider: 'rukiye_zara',
    async getProperty() {
      throw new Error('not used');
    },
    async getReservation() {
      throw new Error('not used');
    },
    async listReservations(input) {
      expect(input.limit).toBe(PMS_RECONCILIATION_PAGE_SIZE);
      const page = pages[index++];
      if (page instanceof Error) throw page;
      if (!page) throw new Error('unexpected page');
      return page;
    },
  };
}

function workerDependencies(
  store: MemoryReconciliationStore,
  reservations: MemoryReservationStore,
  canonical: PmsProvider
) {
  return {
    store,
    reservationStore: reservations,
    createProvider: () => canonical,
    now: () => new Date(NOW),
  };
}

describe('periodic PMS reservation reconciliation', () => {
  it('loads the persisted property watermark for an atomic claim', async () => {
    const watermark = '2026-09-27T00:00:00.000Z';
    const inFilter = vi.fn(async () => ({
      data: [{ id: claim.propertyId, last_reconciled_at: watermark }],
      error: null,
    }));
    const admin = {
      rpc: vi.fn(async () => ({
        data: [
          {
            property_id: claim.propertyId,
            account_id: claim.accountId,
            external_property_id: claim.externalPropertyId,
            pms_integration_id: claim.integration.integrationId,
            provider: claim.integration.provider,
            external_account_id: claim.integration.externalAccountId,
            reconciliation_started_at: NOW.toISOString(),
            reconciliation_attempt_count: 2,
          },
        ],
        error: null,
      })),
      from: vi.fn(() => ({
        select: vi.fn(() => ({ in: inFilter })),
      })),
    };

    const [claimed] = await new SupabasePmsReconciliationStore(
      admin as never
    ).claimProperties({
      limit: 10,
      now: NOW.toISOString(),
      dueBefore: '2026-09-28T06:00:00.000Z',
      staleBefore: '2026-09-28T11:45:00.000Z',
    });

    expect(claimed.lastReconciledAt).toBe(watermark);
    expect(inFilter).toHaveBeenCalledWith('id', [claim.propertyId]);
  });

  it('successfully reconciles every cursor page before advancing the watermark', async () => {
    const previous = '2026-09-27T00:00:00.000Z';
    const state = new MemoryReconciliationStore(
      { lastReconciledAt: previous },
      { ...claim, attemptCount: 0 }
    );
    const projections = new MemoryReservationStore();
    const listReservations = vi.fn(
      provider([
        {
          items: [reservation('one')],
          nextCursor: 'cursor-1',
          hasMore: true,
        },
        { items: [reservation('two')], nextCursor: null, hasMore: false },
      ]).listReservations
    );
    const canonical = {
      ...provider([]),
      listReservations,
    } as PmsProvider;

    const result = await runPmsReservationReconciliationWorker(
      workerDependencies(state, projections, canonical)
    );

    expect(result).toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      reservationsProcessed: 2,
    });
    expect(
      listReservations.mock.calls.map(([input]) => input.cursor ?? null)
    ).toEqual([null, 'cursor-1']);
    expect(
      listReservations.mock.calls.map(([input]) => input.updatedSince)
    ).toEqual([previous, previous]);
    expect(state.rows[0].lastReconciledAt).toBe(NOW.toISOString());
    expect(projections.reservations).toHaveLength(2);
  });

  it('updates an existing reservation and reuses its existing contact', async () => {
    const state = new MemoryReconciliationStore(
      {},
      { ...claim, attemptCount: 0 }
    );
    const projections = new MemoryReservationStore();
    projections.contacts.push({
      id: 'existing-contact',
      phone: '+14155550123',
      name: 'CRM Guest',
      email: 'guest@example.com',
    });
    projections.mappings.set('integration-1:guest-1', 'existing-contact');
    projections.reservations.set('integration-1:existing', {
      id: 'existing-reservation',
      externalUpdatedAt: '2026-09-27T10:00:00.000Z',
      status: 'confirmed',
      contactId: 'existing-contact',
    });

    await runPmsReservationReconciliationWorker(
      workerDependencies(
        state,
        projections,
        provider([
          {
            items: [
              reservation('existing', {
                status: 'confirmed',
                providerStatus: 'modified',
                updatedAt: '2026-09-28T11:30:00.000Z',
              }),
            ],
            nextCursor: null,
            hasMore: false,
          },
        ])
      )
    );

    expect(projections.contacts).toHaveLength(1);
    expect(projections.reservations).toHaveLength(1);
    expect(
      projections.reservations.get('integration-1:existing')
    ).toMatchObject({
      id: 'existing-reservation',
      status: 'confirmed',
      contactId: 'existing-contact',
    });
  });

  it('keeps webhook and reconciliation projection of the same reservation idempotent', async () => {
    const state = new MemoryReconciliationStore(
      {},
      { ...claim, attemptCount: 0 }
    );
    const projections = new MemoryReservationStore();
    const item = reservation('concurrent');
    const canonical = provider([
      { items: [item], nextCursor: null, hasMore: false },
    ]);
    canonical.getReservation = async () => item;
    const event: PmsWebhookEventClaim = {
      id: 'event-row-1',
      provider: claim.integration.provider,
      externalEventId: 'event-1',
      accountId: claim.accountId,
      integrationId: claim.integration.integrationId,
      propertyId: claim.propertyId,
      eventType: 'reservation.updated',
      externalResourceId: item.externalId,
      occurredAt: item.updatedAt,
      processingStartedAt: NOW.toISOString(),
      attemptCount: 1,
    };
    const eventStore: PmsWebhookEventStore = {
      async claimEvents() {
        return [];
      },
      async loadContext() {
        return {
          integration: claim.integration,
          property: {
            id: claim.propertyId,
            accountId: claim.accountId,
            integrationId: claim.integration.integrationId,
            externalPropertyId: claim.externalPropertyId,
          },
        };
      },
      async markProcessed() {},
      async markIgnored() {},
      async markFailed() {},
    };

    await Promise.all([
      runPmsReservationReconciliationWorker(
        workerDependencies(state, projections, canonical)
      ),
      processPmsWebhookEvent(event, {
        store: eventStore,
        reservationStore: projections,
        createProvider: () => canonical,
        now: () => new Date(NOW),
      }),
    ]);

    expect(projections.contacts).toHaveLength(1);
    expect(projections.mappings).toHaveLength(1);
    expect(projections.reservations).toHaveLength(1);
  });

  it('allows only one of two concurrent worker invocations to claim a property', async () => {
    const state = new MemoryReconciliationStore(
      {},
      { ...claim, attemptCount: 0 }
    );
    const projections = new MemoryReservationStore();
    const listReservations = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
    }));
    const canonical = {
      ...provider([]),
      listReservations,
    } as PmsProvider;

    const results = await Promise.all([
      runPmsReservationReconciliationWorker(
        workerDependencies(state, projections, canonical)
      ),
      runPmsReservationReconciliationWorker(
        workerDependencies(state, projections, canonical)
      ),
    ]);

    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(listReservations).toHaveBeenCalledOnce();
  });

  it('records provider failure without advancing the successful watermark', async () => {
    const previous = '2026-09-27T00:00:00.000Z';
    const state = new MemoryReconciliationStore(
      { lastReconciledAt: previous },
      { ...claim, attemptCount: 0 }
    );

    const result = await runPmsReservationReconciliationWorker(
      workerDependencies(
        state,
        new MemoryReservationStore(),
        provider([
          new PmsProviderError(
            'upstream_temporary',
            'provider secret must not leak'
          ),
        ])
      )
    );

    expect(result.failed).toBe(1);
    expect(state.rows[0].lastReconciledAt).toBe(previous);
    expect(state.rows[0].error).toBe(
      'provider_upstream_temporary: PMS reservation listing failed.'
    );
    expect(state.rows[0].nextAttemptAt).toBe('2026-09-28T18:00:00.000Z');
  });

  it('does not advance the watermark when a later page fails', async () => {
    const previous = '2026-09-27T00:00:00.000Z';
    const state = new MemoryReconciliationStore(
      { lastReconciledAt: previous },
      { ...claim, attemptCount: 0 }
    );
    const projections = new MemoryReservationStore();

    const result = await runPmsReservationReconciliationWorker(
      workerDependencies(
        state,
        projections,
        provider([
          {
            items: [reservation('first-page')],
            nextCursor: 'next',
            hasMore: true,
          },
          new Error('second page failed'),
        ])
      )
    );

    expect(result).toMatchObject({ failed: 1, reservationsProcessed: 1 });
    expect(state.rows[0].lastReconciledAt).toBe(previous);
    expect(projections.reservations).toHaveLength(1);
  });

  it('rejects missing and repeated pagination cursors without completing', async () => {
    for (const pages of [
      [{ items: [], nextCursor: null, hasMore: true }],
      [
        { items: [], nextCursor: 'same', hasMore: true },
        { items: [], nextCursor: 'same', hasMore: true },
      ],
    ] satisfies PmsReservationPage[][]) {
      const state = new MemoryReconciliationStore(
        {},
        { ...claim, attemptCount: 0 }
      );
      const result = await runPmsReservationReconciliationWorker(
        workerDependencies(state, new MemoryReservationStore(), provider(pages))
      );
      expect(result.failed).toBe(1);
      expect(state.rows[0].lastReconciledAt).toBeNull();
      expect(state.rows[0].error).toMatch(/pagination/);
    }
  });

  it('does not claim disconnected integrations or inactive properties', async () => {
    for (const row of [{ connected: false }, { active: false }]) {
      const state = new MemoryReconciliationStore(row, {
        ...claim,
        attemptCount: 0,
      });
      const canonical = provider([]);
      const result = await runPmsReservationReconciliationWorker(
        workerDependencies(state, new MemoryReservationStore(), canonical)
      );
      expect(result.claimed).toBe(0);
    }
  });

  it('recovers a stale lease but does not take over a fresh one', async () => {
    const stale = new MemoryReconciliationStore(
      {
        status: 'processing',
        startedAt: new Date(
          NOW.getTime() - PMS_RECONCILIATION_STALE_MS - 1
        ).toISOString(),
      },
      { ...claim, attemptCount: 1 }
    );
    const recovered = await runPmsReservationReconciliationWorker(
      workerDependencies(
        stale,
        new MemoryReservationStore(),
        provider([{ items: [], nextCursor: null, hasMore: false }])
      )
    );
    expect(recovered.completed).toBe(1);
    expect(stale.rows[0].claim.attemptCount).toBe(2);

    const fresh = new MemoryReconciliationStore(
      { status: 'processing', startedAt: NOW.toISOString() },
      { ...claim, attemptCount: 1 }
    );
    const skipped = await runPmsReservationReconciliationWorker(
      workerDependencies(fresh, new MemoryReservationStore(), provider([]))
    );
    expect(skipped.claimed).toBe(0);
  });

  it('uses a six-hour due window and never deletes absent reservations', async () => {
    const state = new MemoryReconciliationStore(
      {
        lastReconciledAt: new Date(
          NOW.getTime() - PMS_RECONCILIATION_INTERVAL_MS + 1
        ).toISOString(),
      },
      { ...claim, attemptCount: 0 }
    );
    const projections = new MemoryReservationStore();
    projections.reservations.set('integration-1:absent', {
      id: 'keep-me',
      externalUpdatedAt: null,
      status: 'confirmed',
      contactId: null,
    });

    const notDue = await runPmsReservationReconciliationWorker(
      workerDependencies(state, projections, provider([]))
    );
    expect(notDue.claimed).toBe(0);

    state.rows[0].lastReconciledAt = '2026-09-28T05:59:59.000Z';
    const due = await runPmsReservationReconciliationWorker(
      workerDependencies(
        state,
        projections,
        provider([{ items: [], nextCursor: null, hasMore: false }])
      )
    );
    expect(due.completed).toBe(1);
    expect(projections.reservations.get('integration-1:absent')?.id).toBe(
      'keep-me'
    );
  });
});
