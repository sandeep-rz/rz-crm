import { describe, expect, it } from 'vitest';
import { workspaceDefaults, isTimezone } from './workspace-defaults';

describe('new workspace defaults', () => {
  it.each([
    ['Asia/Kolkata', 'INR'],
    ['Asia/Calcutta', 'INR'],
    ['Europe/London', 'GBP'],
    ['Europe/Paris', 'EUR'],
    ['America/New_York', 'USD'],
    ['Australia/Sydney', 'AUD'],
  ])('infers currency from %s', (zone, currency) => {
    expect(workspaceDefaults(zone)).toEqual({
      default_timezone: zone,
      default_currency: currency,
    });
  });
  it('uses safe defaults when no location is available', () => {
    expect(workspaceDefaults()).toEqual({
      default_timezone: 'UTC',
      default_currency: 'USD',
    });
    expect(workspaceDefaults('invalid')).toEqual(workspaceDefaults());
    expect(isTimezone('invalid')).toBe(false);
  });
  it('respects an explicitly supplied supported currency', () => {
    expect(workspaceDefaults('Asia/Kolkata', 'GBP').default_currency).toBe(
      'GBP'
    );
  });
});
