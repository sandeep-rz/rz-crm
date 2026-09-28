import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runWorker: vi.fn(),
}));

vi.mock('@/lib/integrations/pms/webhooks/event-processor', () => ({
  runPmsWebhookEventWorker: h.runWorker,
}));

import { POST } from './route';

const TOKEN = 'shared-pms-worker-token';

function request(token?: string) {
  return new Request('http://localhost/api/integrations/pms/webhooks/worker', {
    method: 'POST',
    headers: token ? { 'x-pms-sync-worker-token': token } : undefined,
    body: '{}',
  });
}

beforeEach(() => {
  process.env.PMS_SYNC_WORKER_TOKEN = TOKEN;
  h.runWorker.mockResolvedValue({
    claimed: 2,
    processed: 1,
    failed: 1,
    ignored: 0,
  });
});

afterEach(() => {
  delete process.env.PMS_SYNC_WORKER_TOKEN;
  vi.restoreAllMocks();
});

describe('POST /api/integrations/pms/webhooks/worker', () => {
  it('rejects a missing or invalid shared worker token', async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request('wrong-token'))).status).toBe(401);
    expect(h.runWorker).not.toHaveBeenCalled();
  });

  it('returns 503 when the worker token is not configured', async () => {
    delete process.env.PMS_SYNC_WORKER_TOKEN;

    const response = await POST(request(TOKEN));

    expect(response.status).toBe(503);
    expect(h.runWorker).not.toHaveBeenCalled();
  });

  it('returns only the bounded worker summary', async () => {
    const response = await POST(request(TOKEN));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 2,
      processed: 1,
      failed: 1,
      ignored: 0,
    });
  });

  it('does not log or return internal worker errors or secrets', async () => {
    const secret = 'provider-secret-never-expose';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    h.runWorker.mockRejectedValue(new Error(`failure ${secret}`));

    const response = await POST(request(TOKEN));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(secret);
    expect(body).not.toContain(TOKEN);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
  });
});
