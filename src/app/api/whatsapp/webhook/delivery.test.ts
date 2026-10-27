import { beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { POST } from './route';
const h = vi.hoisted(() => ({
  capture: vi.fn(),
  run: vi.fn(),
  after: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/whatsapp/webhook-runtime', () => ({
  captureWhatsAppDelivery: h.capture,
  runWhatsAppWorker: h.run,
}));
vi.mock('next/server', async (original) => ({
  ...(await original<object>()),
  after: h.after,
}));
const body = JSON.stringify({ entry: [] });
const signature = createHmac('sha256', 'test-meta-app-secret')
  .update(body)
  .digest('hex');
const request = (signed = true) =>
  new Request('https://crm.test/api/whatsapp/webhook', {
    method: 'POST',
    body,
    headers: {
      'x-hub-signature-256': signed ? `sha256=${signature}` : 'invalid',
    },
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.capture.mockResolvedValue(undefined);
});
it('rejects unsigned intake without storing or dispatching it', async () => {
  expect((await POST(request(false))).status).toBe(401);
  expect(h.capture).not.toHaveBeenCalled();
  expect(h.after).not.toHaveBeenCalled();
});
it('acknowledges only after durable capture and keeps Meta retryable on failure', async () => {
  expect((await POST(request())).status).toBe(200);
  expect(h.capture.mock.invocationCallOrder[0]).toBeLessThan(
    h.after.mock.invocationCallOrder[0]
  );
  h.capture.mockRejectedValue(new Error('private backend error'));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(h.after).toHaveBeenCalledTimes(1);
  expect(await response.text()).not.toContain('private');
});

it('rejects a chunked oversized body before durable capture or dispatch', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(2_100_000));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  const res = await POST(
    new Request('https://crm.test/api/whatsapp/webhook', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit)
  );
  expect(res.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(h.capture).not.toHaveBeenCalled();
  expect(h.after).not.toHaveBeenCalled();
});
