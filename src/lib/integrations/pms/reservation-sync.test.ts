import { describe, expect, it, vi } from 'vitest';

import type { PmsReservation } from './provider';
import {
  syncPmsReservation,
  normalizePmsGuestPatch,
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

describe('provider-neutral reservation enrichment', () => {
  it('normalizes known international values and never guesses a country code', () => {
    expect(
      normalizePmsGuestPatch({
        externalId: null,
        phone: '00 44 20 7946 0958',
        fullName: ' Ada ',
        email: 'Ada@EXAMPLE.com ',
      })
    ).toEqual({
      phone: '+442079460958',
      name: 'Ada',
      email: 'ada@example.com',
    });
    expect(
      normalizePmsGuestPatch({
        externalId: null,
        phone: '4155550123',
        fullName: null,
        email: 'relay@guest.booking.com',
      })
    ).toEqual({});
  });

  it('distinguishes missing OTA fields from an explicit clear', () => {
    const guest = {
      externalId: null,
      phone: null,
      fullName: null,
      email: null,
    };
    expect(normalizePmsGuestPatch(guest)).toEqual({});
    expect(
      normalizePmsGuestPatch({ ...guest, clearedFields: ['phone', 'email'] })
    ).toEqual({ phone: null, email: null });
  });

  it('rejects a cross-account integration or mismatched property before writing', async () => {
    const upsert = vi.fn<PmsReservationSyncStore['upsert']>();
    await expect(
      syncPmsReservation(
        { accountId: 'other', integration, property, reservation },
        { upsert }
      )
    ).rejects.toThrow('Integration/account context mismatch');
    await expect(
      syncPmsReservation(
        {
          accountId: integration.accountId,
          integration,
          property: { ...property, externalPropertyId: 'other' },
          reservation,
        },
        { upsert }
      )
    ).rejects.toThrow('different PMS property');
    expect(upsert).not.toHaveBeenCalled();
  });
});
