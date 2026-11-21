import { describe, expect, it, vi } from 'vitest';

import type { PmsProvider, PmsReservation } from './provider';
import {
  PmsGuestSyncError,
  syncPmsGuestContact,
  type GuestSyncContext,
  type GuestSyncStore,
} from './guest-sync';

const ctx: GuestSyncContext = {
  accountId: 'account-1',
  integration: {
    integrationId: 'integration-1',
    accountId: 'account-1',
    provider: 'rukiye_zara',
    externalAccountId: 'host-1',
  },
  propertyId: 'property-1',
  externalPropertyId: '83628',
  externalGuestId: 'guest-1',
  occurredAt: '2026-11-21T13:15:25.050Z',
};

function fixture(input?: Partial<PmsReservation['guest']>): PmsReservation {
  return {
    externalId: 'reservation-1',
    externalPropertyId: '83628',
    externalListingId: 'listing-1',
    sourceType: 'pms_bookings',
    reservationCode: 'ABC',
    status: 'confirmed',
    providerStatus: 'new',
    checkIn: '2026-11-22',
    checkOut: '2026-11-24',
    guest: {
      externalId: 'guest-1',
      fullName: 'Tamal Pal',
      email: 'taman.pal@gmail.com',
      phone: '+919876543210',
      ...input,
    },
    occupancy: { adults: 1, children: 0, infants: 0, pets: 0, total: 1 },
    channel: { code: 'ABB', name: 'Airbnb' },
    financial: {
      totalAmount: 100,
      paidAmount: null,
      balanceDue: null,
      currency: 'INR',
      paymentStatus: null,
    },
    createdAt: null,
    updatedAt: ctx.occurredAt,
  };
}

function harness(reservation: PmsReservation = fixture()) {
  const getReservation = vi.fn(async () => reservation);
  const provider = {
    provider: 'rukiye_zara',
    getReservation,
  } as unknown as PmsProvider;
  const findLinkedReservation = vi.fn(async () => 'reservation-1');
  const updateMappedContact = vi.fn(async () => true);
  const store: GuestSyncStore = { findLinkedReservation, updateMappedContact };
  return { provider, store, getReservation, findLinkedReservation, updateMappedContact };
}

describe('PMS guest.updated contact sync', () => {
  it('updates only a mapped contact from a canonical reservation; no automations', async () => {
    const h = harness();
    await expect(syncPmsGuestContact(ctx, h.provider, h.store)).resolves.toBe('updated');
    expect(h.getReservation).toHaveBeenCalledWith({
      integration: ctx.integration,
      externalPropertyId: ctx.externalPropertyId,
      externalReservationId: 'reservation-1',
    });
    expect(h.updateMappedContact).toHaveBeenCalledWith({
      ...ctx,
      name: 'Tamal Pal',
      email: 'taman.pal@gmail.com',
      phone: '+919876543210',
    });
  });

  it('does not create contacts when no reservation mapping exists', async () => {
    const h = harness();
    h.findLinkedReservation.mockResolvedValue(null as never);
    await expect(syncPmsGuestContact(ctx, h.provider, h.store)).resolves.toBe('unmapped');
    expect(h.getReservation).not.toHaveBeenCalled();
    expect(h.updateMappedContact).not.toHaveBeenCalled();
  });

  it('rejects a reservation that now belongs to a different guest', async () => {
    const h = harness(fixture({ externalId: 'other-guest' }));
    await expect(syncPmsGuestContact(ctx, h.provider, h.store)).rejects.toMatchObject({
      code: 'guest_mismatch',
    } satisfies Partial<PmsGuestSyncError>);
    expect(h.updateMappedContact).not.toHaveBeenCalled();
  });

  it('does not erase an E.164 CRM phone when PMS only has an unqualified local number', async () => {
    const h = harness(fixture({ phone: '9876543210' }));
    await syncPmsGuestContact(ctx, h.provider, h.store);
    expect(h.updateMappedContact).toHaveBeenCalledWith(
      expect.objectContaining({ phone: null })
    );
  });

  it('passes an explicit phone clear to the version-checked RPC', async () => {
    const h = harness(fixture({ phone: null }));
    await syncPmsGuestContact(ctx, h.provider, h.store);
    expect(h.updateMappedContact).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '' })
    );
  });
});
