import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import {
  ContactStaySummary,
  ContactStays,
  ReservationDetails,
} from './contact-stays';
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
  } = {}
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <ContactStays
        stays={stays}
        error={options.error}
        onOpenStay={() => undefined}
      />
    </NextIntlClientProvider>
  );
}

function renderDetail(selected: ContactStay) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <ReservationDetails stay={selected} guest={GUEST} locale="en" />
    </NextIntlClientProvider>
  );
}

describe('ContactStays', () => {
  it('renders one reservation without internal ids', () => {
    const html = renderStays([stay()]);
    expect(html).toContain('Palm House');
    expect(html).toContain('RZ-100');
    expect(html).toContain('Upcoming');
    expect(html).toContain('3 nights');
    expect(html).toContain('Airbnb');
    expect(html).toContain('₹1,200');
    expect(html).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(html).not.toContain('metadata');
    expect(html).toContain('button');
    expect(html).toContain('chevron-right');
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
    expect(html).toContain('Current');
    expect(html).toContain('Upcoming');
    expect(html).toContain('Past stays');
    expect(html).toContain('Cancelled');
    expect(html).toContain('Palm House');
    expect(html).toContain('Hill Cottage');
    expect(html).toContain('In house');
    expect(html).toContain('Completed / Past');
  });

  it('hides missing money, channel, and occupancy on the detail', () => {
    const html = renderDetail(
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
      })
    );
    expect(html).toContain('Stay');
    expect(html).toContain('Palm House');
    expect(html).toContain('Asha Menon');
    expect(html).not.toContain('Channel');
    expect(html).not.toContain('Total');
    expect(html).not.toContain('Adults');
    expect(html).not.toContain('Payment');
    expect(html).not.toContain('System');
    expect(html).toContain('sm:grid-cols-2');
    expect(html).not.toContain('11111111-2222-3333-4444-555555555555');
  });

  it('renders an empty state instead of an error when there are no reservations', () => {
    const html = renderStays([]);
    expect(html).toContain('No reservations yet');
    expect(html).not.toContain('could not be loaded');
  });

  it('keeps long guest and property values inside responsive text containers', () => {
    const longProperty =
      'Lakeside Meadows Heritage Villa With A Very Long Property Name';
    const html = renderDetail(
      stay({
        propertyName: longProperty,
        reservationCode: 'RZ-VERY-LONG-REFERENCE-123456789',
      })
    );
    expect(html).toContain(longProperty);
    expect(html).toContain('break-words');
    expect(html).toContain('sm:grid-cols-2');
  });

  it('renders only the most relevant stay in the details summary', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        <ContactStaySummary
          stays={[
            stay({ id: 'past', propertyName: 'Old Cottage', timing: 'past' }),
            stay({
              id: 'current',
              propertyName: 'Current Villa',
              timing: 'current',
            }),
            stay({ id: 'future', propertyName: 'Future Lodge' }),
          ]}
          onOpenStay={() => undefined}
          onViewAll={() => undefined}
        />
      </NextIntlClientProvider>
    );
    expect(html).toContain('Stay summary');
    expect(html).toContain('Current Villa');
    expect(html).not.toContain('Old Cottage');
    expect(html).not.toContain('Future Lodge');
    expect(html).toContain('View all 3 stays');
  });
});
