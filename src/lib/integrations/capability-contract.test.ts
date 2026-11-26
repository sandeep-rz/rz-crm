import { describe, expect, it } from 'vitest';
import { normalizeUrlCapability } from './capability-contract';

describe('URL capability validation', () => {
  it('rejects malformed and non-https URLs without leaking them', () => {
    for (const value of [
      'not-a-url',
      '',
      'http://example.com/x',
      'javascript:alert(1)',
      'https://user:pass@example.com',
    ]) {
      expect(
        normalizeUrlCapability('reservation.digital_checkin_url', {
          status: 'resolved',
          value,
        })
      ).toEqual({
        capability: 'reservation.digital_checkin_url',
        status: 'unavailable',
        reason: 'unavailable',
      });
    }
  });
  it('returns a valid HTTPS check-in link without changing its token', () => {
    const url = 'https://checkin.example.com/c/secret-token';
    expect(
      normalizeUrlCapability('reservation.digital_checkin_url', {
        status: 'resolved',
        value: url,
      })
    ).toEqual({
      capability: 'reservation.digital_checkin_url',
      status: 'available',
      value: url,
    });
  });
  it('distinguishes disabled property and link not ready', () => {
    expect(
      normalizeUrlCapability('reservation.digital_checkin_url', {
        status: 'missing',
        value: null,
        reason: 'feature_disabled',
      })
    ).toEqual({
      capability: 'reservation.digital_checkin_url',
      status: 'unavailable',
      reason: 'feature_disabled',
    });
    expect(
      normalizeUrlCapability('reservation.digital_checkin_url', {
        status: 'missing',
        value: null,
        reason: 'not_ready',
      })
    ).toEqual({
      capability: 'reservation.digital_checkin_url',
      status: 'unavailable',
      reason: 'not_ready',
    });
  });
});
