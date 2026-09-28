import { describe, expect, it } from 'vitest';

import type { PmsProvider, PmsReservationPage } from './provider';
import {
  PMS_INITIAL_SYNC_PAGE_SIZE,
  runInitialPmsPropertySync,
  type InitialSyncClaim,
  type InitialSyncStore,
} from './initial-sync';
import type {
  PmsContactRecord,
  PmsReservationSyncStore,
} from './reservation-sync';

const claim: InitialSyncClaim = {
  propertyId: 'property-a',
  accountId: 'account-a',
  externalPropertyId: '22008',
  integration: {
    integrationId: 'integration-a',
    accountId: 'account-a',
    provider: 'rukiye_zara',
    externalAccountId: 'pms-account',
  },
};

function reservation(id: string) {
  return {
    externalId: id,
    sourceType: 'bookings',
    externalPropertyId: '22008',
    externalListingId: 'listing',
    reservationCode: id,
    status: 'confirmed',
    checkIn: '2026-10-01',
    checkOut: '2026-10-02',
    guest: { externalId: null, fullName: null, email: null, phone: null },
    occupancy: {
      adults: null,
      children: null,
      infants: null,
      pets: null,
      total: 1,
    },
    channel: { code: 'direct', name: 'Direct' },
    financial: {
      totalAmount: null,
      paidAmount: null,
      balanceDue: null,
      currency: null,
      paymentStatus: null,
    },
    createdAt: null,
    updatedAt: null,
  };
}

class SyncStore implements InitialSyncStore {
  claimResult: InitialSyncClaim | null = claim;
  completed = false;
  failed: string | null = null;
  async claimProperty() {
    const result = this.claimResult;
    this.claimResult = null;
    return result;
  }
  async markCompleted() {
    this.completed = true;
  }
  async markFailed(input: {
    propertyId: string;
    failedAt: string;
    error: string;
  }) {
    void input.propertyId;
    void input.failedAt;
    this.failed = input.error;
  }
}

class ReservationStore implements PmsReservationSyncStore {
  async findGuestMapping() {
    return null;
  }
  async findContactsByPhone() {
    return [];
  }
  async findContactsByEmail() {
    return [];
  }
  async findContactById() {
    return null;
  }
  async createContact(): Promise<never> {
    throw new Error('No contact should be created for null guest data.');
  }
  async enrichContact(input: { contact: PmsContactRecord }) {
    return input.contact;
  }
  async createGuestMapping(): Promise<never> {
    throw new Error('No mapping should be created for null guest data.');
  }
  async findReservation() {
    return null;
  }
  async saveReservation(
    input: Parameters<PmsReservationSyncStore['saveReservation']>[0]
  ) {
    return { id: input.reservation.externalId, skippedStale: false };
  }
}

function provider(pages: PmsReservationPage[]): PmsProvider {
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
      expect(input.limit).toBe(PMS_INITIAL_SYNC_PAGE_SIZE);
      expect(input.updatedSince).toBeUndefined();
      const page = pages[index++];
      expect(input.cursor ?? null).toBe(
        index === 1 ? null : pages[index - 2].nextCursor
      );
      return page;
    },
  };
}

describe('initial PMS property synchronization', () => {
  it('consumes all cursor pages and marks completion', async () => {
    const store = new SyncStore();
    const result = await runInitialPmsPropertySync('property-a', {
      store,
      reservationStore: new ReservationStore(),
      createProvider: () =>
        provider([
          {
            items: [reservation('one')],
            nextCursor: 'cursor-1',
            hasMore: true,
          },
          { items: [reservation('two')], nextCursor: null, hasMore: false },
        ]),
    });
    expect(result).toMatchObject({
      status: 'completed',
      reservationsProcessed: 2,
    });
    expect(store.completed).toBe(true);
  });

  it('fails safely when pagination claims more without advancing', async () => {
    const store = new SyncStore();
    const result = await runInitialPmsPropertySync('property-a', {
      store,
      reservationStore: new ReservationStore(),
      createProvider: () =>
        provider([{ items: [], nextCursor: null, hasMore: true }]),
    });
    expect(result.status).toBe('failed');
    expect(store.failed).toMatch(/pagination/);
  });

  it('fails safely on a repeated cursor and allows a forced rerun', async () => {
    const store = new SyncStore();
    const result = await runInitialPmsPropertySync('property-a', {
      store,
      reservationStore: new ReservationStore(),
      createProvider: () =>
        provider([
          { items: [], nextCursor: 'same', hasMore: true },
          { items: [], nextCursor: 'same', hasMore: true },
        ]),
    });
    expect(result.status).toBe('failed');
    store.claimResult = claim;
    const rerun = await runInitialPmsPropertySync('property-a', {
      store,
      force: true,
      reservationStore: new ReservationStore(),
      createProvider: () =>
        provider([{ items: [], nextCursor: null, hasMore: false }]),
    });
    expect(rerun.status).toBe('completed');
  });

  it('does not run a second worker while the property is claimed', async () => {
    const store = new SyncStore();
    store.claimResult = null;
    const result = await runInitialPmsPropertySync('property-a', { store });
    expect(result.status).toBe('already_running');
  });
});
