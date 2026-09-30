import { describe, expect, it } from 'vitest';
import { bookingTotalsByCurrency, classifyReservation, parseReservation, propertyDate } from '.';

const base = {
  status: 'confirmed', checkIn: '2026-09-30', checkOut: '2026-10-02', propertyTimezone: 'Asia/Kolkata',
};

describe('reservation lifecycle', () => {
  it('classifies upcoming, staying now, checked out, and cancelled', () => {
    const now = new Date('2026-09-30T10:00:00Z');
    expect(classifyReservation({ ...base, checkIn: '2026-10-01' }, now)).toBe('upcoming');
    expect(classifyReservation(base, now)).toBe('staying_now');
    expect(classifyReservation({ ...base, checkOut: '2026-09-30' }, now)).toBe('checked_out');
    expect(classifyReservation({ ...base, status: 'cancelled' }, now)).toBe('cancelled');
  });

  it('uses the property timezone at a UTC date boundary', () => {
    const now = new Date('2026-09-30T20:00:00Z'); // Oct 1 in India, Sep 30 in New York
    expect(propertyDate(now, 'Asia/Kolkata')).toBe('2026-10-01');
    expect(propertyDate(now, 'America/New_York')).toBe('2026-09-30');
    expect(classifyReservation({ ...base, checkIn: '2026-10-01' }, now)).toBe('staying_now');
    expect(classifyReservation({ ...base, checkIn: '2026-10-01', propertyTimezone: 'America/New_York' }, now)).toBe('upcoming');
  });
});

describe('reservation presentation', () => {
  it('parses safe optional fields without exposing internal account data', () => {
    const parsed = parseReservation({ id: 'r1', property_id: 'p1', status: 'confirmed', lifecycle: 'upcoming', property_timezone: 'UTC', total_count: 1, metadata: { secret: true }, account_id: 'a1' });
    expect(parsed).toMatchObject({ id: 'r1', propertyId: 'p1', lifecycle: 'upcoming', guestName: null, totalAmount: null });
    expect(parsed).not.toHaveProperty('metadata');
    expect(parsed).not.toHaveProperty('accountId');
  });

  it('keeps mixed-currency totals separate', () => {
    const totals = bookingTotalsByCurrency([
      { totalAmount: 100, currency: 'INR' }, { totalAmount: 50, currency: 'inr' }, { totalAmount: 20, currency: 'USD' },
    ]);
    expect([...totals]).toEqual([['INR', 150], ['USD', 20]]);
  });
});
