import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState, ReservationCard } from './reservations-page';
import type { ReservationRecord } from '@/lib/reservations';

const row: ReservationRecord = {
  id: 'internal-reservation-id',
  contactId: null,
  propertyId: 'internal-property-id',
  propertyName: null,
  propertyTimezone: 'UTC',
  provider: 'custom_pms',
  providerName: null,
  guestName: null,
  guestPhone: null,
  guestEmail: null,
  reservationCode: null,
  status: 'confirmed',
  providerStatus: null,
  lifecycle: 'upcoming',
  checkIn: null,
  checkOut: null,
  adults: null,
  children: null,
  infants: null,
  pets: null,
  occupancyTotal: null,
  channel: null,
  totalAmount: null,
  currency: null,
  lastSyncedAt: null,
  totalCount: 1,
};

describe('reservations page states', () => {
  it.each([
    [{ connected: false, syncing: false, filtered: false }, 'No PMS connected'],
    [
      { connected: false, syncing: true, filtered: false },
      'Syncing reservations',
    ],
    [
      { connected: true, syncing: false, filtered: false },
      'No reservations found',
    ],
    [
      { connected: true, syncing: false, filtered: true },
      'No reservations match these filters',
    ],
  ] as const)('renders the distinct empty state %#', (props, expected) => {
    expect(renderToStaticMarkup(<EmptyState {...props} />)).toContain(expected);
  });

  it('renders missing optional fields safely without internal ids', () => {
    const html = renderToStaticMarkup(
      <ReservationCard row={row} onSelect={() => undefined} />
    );
    expect(html).toContain('Unlinked guest');
    expect(html).toContain('Unnamed property');
    expect(html).toContain('Dates unavailable');
    expect(html).not.toContain('internal-reservation-id');
    expect(html).not.toContain('internal-property-id');
    expect(html).not.toContain('null');
    expect(html).not.toContain('undefined');
  });
});
