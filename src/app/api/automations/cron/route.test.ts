import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(async () => ({ claimed: 1, completed: 1, retried: 0, failed: 0 })),
}));

vi.mock('@/lib/automations/pending-worker', () => ({
  runPendingExecutionWorker: mocks.run,
}));

import { GET } from './route';

describe('automation pending cron authorization', () => {
  beforeEach(() => {
    process.env.AUTOMATION_CRON_SECRET = 'correct-secret';
    mocks.run.mockClear();
  });

  afterEach(() => {
    delete process.env.AUTOMATION_CRON_SECRET;
  });

  it('rejects requests without the cron secret', async () => {
    const response = await GET(
      new Request('http://localhost/api/automations/cron')
    );
    expect(response.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('runs the hardened worker with the correct secret', async () => {
    const response = await GET(
      new Request('http://localhost/api/automations/cron', {
        headers: { 'x-cron-secret': 'correct-secret' },
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the cron secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    const response = await GET(
      new Request('http://localhost/api/automations/cron')
    );
    expect(response.status).toBe(503);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
