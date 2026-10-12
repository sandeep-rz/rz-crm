import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  captureWhatsAppDelivery,
  deliveryStage,
  runWhatsAppWorker,
} from './webhook-runtime';
const h = vi.hoisted(() => ({
  process: vi.fn(),
  capture: vi.fn(),
  drain: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('./webhook-processor', () => ({ processWebhook: h.process }));
vi.mock('./coexistence-webhook', () => ({
  captureCoexistenceWebhook: h.capture,
  drainCoexistenceWebhook: h.drain,
}));
vi.mock('./coexistence-sync', () => ({ resumeCoexistenceSync: h.sync }));
const mockRpc = (
  fn: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ data?: unknown; error: unknown }>
) => vi.fn(fn);
const db = (rpc: ReturnType<typeof vi.fn>) =>
  ({ rpc }) as unknown as SupabaseClient;
beforeEach(() => {
  vi.clearAllMocks();
  h.process.mockResolvedValue(undefined);
  h.capture.mockResolvedValue(false);
  h.drain.mockResolvedValue(undefined);
  h.sync.mockResolvedValue(true);
});
const envelope = (id: string, time = 1) => ({
  entry: [
    {
      id: '123',
      time,
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: '456' },
            messages: [{ id, type: 'text' }],
          },
        },
      ],
    },
  ],
});
it('captures each message separately and deduplicates identities across retry envelope timestamps', async () => {
  const rpc = mockRpc(async () => ({ error: null }));
  await captureWhatsAppDelivery(db(rpc), envelope('first'));
  await captureWhatsAppDelivery(db(rpc), envelope('first', 2));
  await captureWhatsAppDelivery(db(rpc), envelope('second'));
  expect((rpc.mock.calls[0][1].p_deliveries as { key: string }[])[0].key).toBe(
    (rpc.mock.calls[1][1].p_deliveries as { key: string }[])[0].key
  );
  expect(
    (rpc.mock.calls[2][1].p_deliveries as { key: string }[])[0].key
  ).not.toBe((rpc.mock.calls[0][1].p_deliveries as { key: string }[])[0].key);
});
it('storage failure propagates before acknowledgement', async () => {
  await expect(
    captureWhatsAppDelivery(
      db(vi.fn(async () => ({ error: { code: 'down' } }))),
      envelope('first')
    )
  ).rejects.toThrow('delivery_capture_failed');
});
it('does not repeat an interrupted external action and reuses completed flow results', async () => {
  const action = vi.fn(async () => ({ consumed: true }));
  const rpc = mockRpc(async () => ({
    data: { state: 'started', lease: 'old' },
    error: null,
  }));
  await expect(
    deliveryStage(db(rpc), { id: 1, lease: 'new' }, 'flow', action)
  ).rejects.toThrow('external_stage_outcome_unknown');
  expect(action).not.toHaveBeenCalled();
  rpc.mockResolvedValue({
    data: { state: 'done', result: { consumed: true } },
    error: null,
  });
  expect(
    await deliveryStage(db(rpc), { id: 1, lease: 'new' }, 'flow', action)
  ).toEqual({ consumed: true });
  expect(action).not.toHaveBeenCalled();
});
it('commits a stage claim before executing and reports unconfirmed result persistence', async () => {
  let claimed = false;
  const rpc = mockRpc(async (_name, args) => {
    if (args.p_result) {
      return { error: { code: 'down' } };
    }
    claimed = true;
    return { data: { state: 'claimed' }, error: null };
  });
  const action = vi.fn(async () => {
    expect(claimed).toBe(true);
    return { consumed: false };
  });
  await expect(
    deliveryStage(db(rpc), { id: 1, lease: 'lease' }, 'flow', action)
  ).rejects.toThrow('stage_result_unconfirmed');
  expect(action).toHaveBeenCalledOnce();
});
it('retains unresolved routing for retry, applies lifecycle before live dispatch, and resumes missing sync', async () => {
  h.capture.mockRejectedValueOnce(new Error('coexistence_routing_unresolved'));
  const claimed = [
    { id: 1, payload: envelope('one') },
    { id: 2, payload: envelope('two') },
  ];
  const rpc = mockRpc(async (name) =>
    name === 'claim_whatsapp_deliveries'
      ? { data: claimed.length ? [claimed.shift()] : [], error: null }
      : name === 'pending_whatsapp_coexistence_sync'
        ? { data: ['connection'], error: null }
        : { data: null, error: null }
  );
  expect(await runWhatsAppWorker(db(rpc))).toEqual({ processed: 1, failed: 1 });
  expect(
    rpc.mock.calls
      .filter((c) => c[0] === 'finish_whatsapp_delivery')
      .map((c) => c[1].p_error)
  ).toEqual(['coexistence_routing_unresolved', null]);
  expect(h.drain.mock.invocationCallOrder[0]).toBeLessThan(
    h.process.mock.invocationCallOrder[0]
  );
  expect(h.sync).toHaveBeenCalledWith(
    expect.anything(),
    'connection',
    expect.any(Number)
  );
});

it('captures coexistence before ACK while retaining unresolved routes in durable raw storage', async () => {
  const rpc = mockRpc(async () => ({ error: null }));
  h.capture.mockRejectedValueOnce(new Error('coexistence_routing_unresolved'));
  await expect(
    captureWhatsAppDelivery(db(rpc), envelope('unresolved'))
  ).resolves.toBeUndefined();
  expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
    h.capture.mock.invocationCallOrder[0]
  );
  h.capture.mockRejectedValueOnce(new Error('storage_failure'));
  await expect(
    captureWhatsAppDelivery(db(rpc), envelope('another'))
  ).rejects.toThrow('storage_failure');
});

it('defers unmatched statuses and template DB failures without completing their durable receipts', async () => {
  for (const reason of ['status_unmatched', 'template_write_failed']) {
    let claims = 0;
    const rpc = mockRpc(async (name) => ({
      error: null,
      data:
        name === 'claim_whatsapp_deliveries' && claims++ === 0
          ? [{ id: 1, payload: envelope('one') }]
          : [],
    }));
    h.process.mockRejectedValueOnce(new Error(reason));
    await runWhatsAppWorker(db(rpc));
    expect(rpc).toHaveBeenCalledWith(
      'finish_whatsapp_delivery',
      expect.objectContaining({ p_id: 1, p_error: reason })
    );
  }
});
it('drains only a small live/lifecycle batch between inbound receipts and bounded history afterward', async () => {
  let claims = 0;
  const rpc = mockRpc(async (name) => ({
    error: null,
    data:
      name === 'claim_whatsapp_deliveries' && claims++ === 0
        ? [{ id: 1, payload: envelope('one') }]
        : [],
  }));
  await runWhatsAppWorker(db(rpc));
  expect(h.drain.mock.calls.map((call) => call.slice(1))).toEqual([
    [1, 1],
    [5],
  ]);
});
