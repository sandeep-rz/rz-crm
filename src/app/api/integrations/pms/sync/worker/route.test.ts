import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  limit: vi.fn(),
  runInitialSync: vi.fn(),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        or: () => ({
          order: () => ({ limit: h.limit }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/integrations/pms/initial-sync', () => ({
  runInitialPmsPropertySync: h.runInitialSync,
}));

import { POST } from './route';

const TOKEN = 'worker-token-for-tests';

function request(token?: string) {
  return new Request('http://localhost/api/integrations/pms/sync/worker', {
    method: 'POST',
    headers: token ? { 'x-pms-sync-worker-token': token } : undefined,
    body: '{}',
  });
}

beforeEach(() => {
  process.env.PMS_SYNC_WORKER_TOKEN = TOKEN;
  h.limit.mockResolvedValue({ data: [], error: null });
  h.runInitialSync.mockResolvedValue({ status: 'completed' });
});

afterEach(() => {
  delete process.env.PMS_SYNC_WORKER_TOKEN;
  vi.clearAllMocks();
});

describe('POST /api/integrations/pms/sync/worker', () => {
  it('returns 503 until the server-side worker token is configured', async () => {
    delete process.env.PMS_SYNC_WORKER_TOKEN;

    const response = await POST(request(TOKEN));

    expect(response.status).toBe(503);
    expect(h.limit).not.toHaveBeenCalled();
  });

  it('rejects a missing or incorrect worker token', async () => {
    const missing = await POST(request());
    const incorrect = await POST(request('not-the-token'));

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(h.limit).not.toHaveBeenCalled();
  });

  it('scans eligible properties and delegates synchronization to the existing worker', async () => {
    h.limit.mockResolvedValue({
      data: [{ id: 'property-a' }, { id: 'property-b' }],
      error: null,
    });
    h.runInitialSync
      .mockResolvedValueOnce({ status: 'completed' })
      .mockResolvedValueOnce({ status: 'already_claimed' });

    const response = await POST(request(TOKEN));

    expect(response.status).toBe(200);
    expect(h.limit).toHaveBeenCalledWith(10);
    expect(h.runInitialSync).toHaveBeenNthCalledWith(1, 'property-a');
    expect(h.runInitialSync).toHaveBeenNthCalledWith(2, 'property-b');
    expect(await response.json()).toMatchObject({ processed: 2 });
  });

  it('returns 500 when the property scan fails', async () => {
    h.limit.mockResolvedValue({ data: null, error: { message: 'private' } });

    const response = await POST(request(TOKEN));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'PMS sync scan failed.' });
    expect(h.runInitialSync).not.toHaveBeenCalled();
  });
});
