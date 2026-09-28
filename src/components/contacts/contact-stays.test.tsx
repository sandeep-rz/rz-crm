import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import { ContactStays } from './contact-stays';
import type { ContactStay } from '@/lib/contacts/pms-stays';

const GUEST = {
  name: 'Asha Menon',
  phone: '+919800000000',
  email: 'asha@example.com',
};

function stay(overrides: Partial<ContactStay> = {}): ContactStay {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    propertyName: 'Palm House',
    reservationCode: 'RZ-100',
    status: 'confirmed',
    providerStatus: null,
    checkIn: '2026-10-02',
    checkOut: '2026-10-05',
    nights: 3,
    adults: 2,
    children: 1,
    infants: null,
    pets: null,
    channel: 'Airbnb',
    totalAmount: 1200,
    currency: 'INR',
    lastSyncedAt: '2026-09-28T08:00:00.000Z',
    timing: 'upcoming',
    ...overrides,
  };
}

function renderStays(
  stays: ContactStay[],
  options: {
    error?: boolean;
    initialSelectedId?: string | null;
    guest?: typeof GUEST;
  } = {}
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <ContactStays
        stays={stays}
        guest={options.guest ?? GUEST}
        error={options.error}
        initialSelectedId={options.initialSelectedId}
      />
    </NextIntlClientProvider>
  );
}

describe('ContactStays', () => {
  it('renders one reservation without internal ids', () => {
    const html = renderStays([stay()]);
    expect(html).toContain('Palm House');
    expect(html).toContain('RZ-100');
    expect(html).toContain('Confirmed');
    expect(html).toContain('Upcoming');
    expect(html).toContain('3 nights');
    expect(html).toContain('Airbnb');
    expect(html).toContain('1,200 INR');
    expect(html).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(html).not.toContain('metadata');
    expect(html).toContain('flex-col');
    expect(html).toContain('sm:flex-row');
  });

  it('renders several stays across properties in separate groups', () => {
    const html = renderStays([
      stay({ id: 'a', propertyName: 'Palm House', timing: 'upcoming' }),
      stay({
        id: 'b',
        propertyName: 'Hill Cottage',
        reservationCode: 'RZ-200',
        timing: 'current',
        checkIn: '2026-09-27',
        checkOut: '2026-09-30',
      }),
      stay({
        id: 'c',
        propertyName: 'Palm House',
        reservationCode: 'RZ-090',
        status: 'completed',
        timing: 'past',
      }),
      stay({
        id: 'd',
        propertyName: 'Hill Cottage',
        reservationCode: 'RZ-050',
        status: 'cancelled',
        timing: 'cancelled',
        channel: null,
        totalAmount: null,
        currency: null,
        adults: null,
        children: null,
      }),
    ]);
    expect(html).toContain('Upcoming and current');
    expect(html).toContain('Past stays');
    expect(html).toContain('Cancelled');
    expect(html).toContain('Palm House');
    expect(html).toContain('Hill Cottage');
    expect(html).toContain('Current');
    expect(html).toContain('sm:flex-row');
  });

  it('hides missing money, channel, and occupancy on the detail', () => {
    const html = renderStays(
      [
        stay({
          channel: null,
          totalAmount: null,
          currency: null,
          adults: null,
          children: null,
          infants: null,
          pets: null,
          nights: null,
          providerStatus: null,
          lastSyncedAt: null,
        }),
      ],
      { initialSelectedId: '11111111-2222-3333-4444-555555555555' }
    );
    expect(html).toContain('Stay');
    expect(html).toContain('Palm House');
    expect(html).toContain('Asha Menon');
    expect(html).not.toContain('Channel');
    expect(html).not.toContain('Total');
    expect(html).not.toContain('Adults');
    expect(html).not.toContain('Financial');
    expect(html).not.toContain('Synchronization');
    expect(html).toContain('sm:grid-cols-2');
    expect(html).not.toContain('11111111-2222-3333-4444-555555555555');
  });

  it('renders an empty state instead of an error when there are no reservations', () => {
    const html = renderStays([]);
    expect(html).toContain('No reservations yet');
    expect(html).not.toContain('could not be loaded');
  });
});
