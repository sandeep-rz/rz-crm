import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ runWorker: vi.fn() }));

vi.mock('@/lib/integrations/pms/reconciliation', () => ({
  runPmsReservationReconciliationWorker: h.runWorker,
}));

import { POST } from './route';

const TOKEN = 'shared-pms-worker-token';

function request(token?: string) {
  return new Request(
    'http://localhost/api/integrations/pms/reconciliation/worker',
    {
      method: 'POST',
      headers: token ? { 'x-pms-sync-worker-token': token } : undefined,
      body: '{}',
    }
  );
}

beforeEach(() => {
  process.env.PMS_SYNC_WORKER_TOKEN = TOKEN;
  h.runWorker.mockResolvedValue({
    claimed: 2,
    completed: 1,
    failed: 1,
    reservationsProcessed: 8,
  });
});

afterEach(() => {
  delete process.env.PMS_SYNC_WORKER_TOKEN;
  vi.restoreAllMocks();
});

describe('POST /api/integrations/pms/reconciliation/worker', () => {
  it('rejects missing or invalid shared worker authentication', async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request('wrong-token'))).status).toBe(401);
    expect(h.runWorker).not.toHaveBeenCalled();
  });

  it('returns 503 when PMS_SYNC_WORKER_TOKEN is not configured', async () => {
    delete process.env.PMS_SYNC_WORKER_TOKEN;
    expect((await POST(request(TOKEN))).status).toBe(503);
    expect(h.runWorker).not.toHaveBeenCalled();
  });

  it('returns the bounded reconciliation summary', async () => {
    const response = await POST(request(TOKEN));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 2,
      completed: 1,
      failed: 1,
      reservationsProcessed: 8,
    });
  });

  it('does not return internal worker errors or secrets', async () => {
    h.runWorker.mockRejectedValue(new Error('provider-secret'));
    const response = await POST(request(TOKEN));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('provider-secret');
    expect(h.runWorker).toHaveBeenCalledOnce();
  });
});
