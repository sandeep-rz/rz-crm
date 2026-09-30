import { describe, expect, it } from 'vitest';

import { capabilityFromConnectionCount } from './capability';

describe('capabilityFromConnectionCount', () => {
  it('keeps WhatsApp-only features locked with no usable connection', () => {
    expect(capabilityFromConnectionCount(0)).toEqual({
      available: false,
      connectionCount: 0,
    });
  });

  it('unlocks for one usable connection', () => {
    expect(capabilityFromConnectionCount(1)).toEqual({
      available: true,
      connectionCount: 1,
    });
  });

  it('preserves multi-connection counts and normalizes absent counts', () => {
    expect(capabilityFromConnectionCount(3)).toEqual({
      available: true,
      connectionCount: 3,
    });
    expect(capabilityFromConnectionCount(null)).toEqual({
      available: false,
      connectionCount: 0,
    });
  });
});
