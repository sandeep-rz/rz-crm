import { describe, expect, it } from 'vitest';
import { isWithinTimeWindow } from './time-window';

describe('automation local time windows', () => {
  it('does not send the overnight reply at 1:30pm IST (08:00 UTC)', () => {
    const now = new Date('2026-10-14T08:00:00Z');
    expect(isWithinTimeWindow('18:00-09:00', 'Asia/Kolkata', now)).toBe(false);
    expect(isWithinTimeWindow('18:00-09:00', 'UTC', now)).toBe(true);
  });
  it.each([
    ['2026-10-14T12:30:00Z', true], // 18:00 start included
    ['2026-10-14T18:30:00Z', true], // midnight
    ['2026-10-15T03:29:00Z', true], // 08:59
    ['2026-10-15T03:30:00Z', false], // 09:00 end excluded
  ])('handles the overnight boundary at %s', (instant, expected) => {
    expect(
      isWithinTimeWindow('18:00–09:00', 'Asia/Kolkata', new Date(instant))
    ).toBe(expected);
  });
  it('uses London daylight saving rules', () => {
    expect(
      isWithinTimeWindow(
        '09:00-10:00',
        'Europe/London',
        new Date('2026-07-14T08:30:00Z')
      )
    ).toBe(true);
    expect(
      isWithinTimeWindow(
        '09:00-10:00',
        'Europe/London',
        new Date('2026-01-14T08:30:00Z')
      )
    ).toBe(false);
  });
  it.each(['25:00-09:00', '18:99-09:00', 'bad'])(
    'rejects malformed windows: %s',
    (operand) => {
      expect(() => isWithinTimeWindow(operand, 'UTC')).toThrow();
    }
  );
  it('rejects invalid timezones instead of using server time', () => {
    expect(() => isWithinTimeWindow('09:00-18:00', 'bad')).toThrow();
  });
});
