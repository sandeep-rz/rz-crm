import { expect, it, vi } from 'vitest';
import { SendTiming } from './send-timing';
it('records successful and failed stages without sensitive payloads', async () => {
  const clock = vi.spyOn(performance, 'now');
  clock.mockReturnValue(0);
  const timing = new SendTiming();
  await timing.measure('auth', async () => {
    clock.mockReturnValue(12);
    return 'private-token';
  });
  await expect(
    timing.measure('provider', async () => {
      clock.mockReturnValue(50);
      throw new Error('secret-message');
    })
  ).rejects.toThrow();
  const header = timing.header();
  expect(header).toContain('auth;dur=12.0');
  expect(header).toContain('provider;dur=38.0');
  expect(header).not.toMatch(/private-token|secret-message/);
  clock.mockRestore();
});
