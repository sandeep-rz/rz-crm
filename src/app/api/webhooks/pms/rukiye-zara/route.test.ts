import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  processEvent: vi.fn(),
}));

vi.mock('@/lib/integrations/pms/webhooks/processor', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/integrations/pms/webhooks/processor')
    >();
  return { ...actual, processRzPmsWebhookEvent: h.processEvent };
});

import { PmsWebhookProcessingError } from '@/lib/integrations/pms/webhooks/processor';

import { POST } from './route';

const SECRET = 'rz-pms-webhook-secret-for-tests';
const NOW = 1_800_000_000;
const BASE_EVENT = {
  id: 'evt-rz-1001',
  type: 'reservation.confirmed',
  api_version: '2026-09-01',
  occurred_at: '2026-09-27T12:00:00.000Z',
  property_id: 22008,
  resource: { type: 'reservation', id: 'RZ-RES-9001' },
  source: null,
  data: { changed_fields: ['status'] },
};

function signature(rawBody: string, timestamp = NOW) {
  const digest = createHmac('sha256', SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `v1=${digest}`;
}

function request(
  rawBody: string,
  options: {
    timestamp?: string | null;
    signature?: string | null;
  } = {}
) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const timestamp =
    options.timestamp === undefined ? String(NOW) : options.timestamp;
  const signatureHeader =
    options.signature === undefined ? signature(rawBody) : options.signature;
  if (timestamp !== null) headers.set('x-rz-timestamp', timestamp);
  if (signatureHeader !== null) {
    headers.set('x-rz-signature', signatureHeader);
  }
  return new Request('http://localhost/api/webhooks/pms/rukiye-zara', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  process.env.RZ_PMS_WEBHOOK_SIGNING_SECRET = SECRET;
  h.processEvent.mockResolvedValue({
    duplicate: false,
    accountId: 'workspace-1',
    integrationId: 'integration-1',
    propertyId: 'property-1',
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RZ_PMS_WEBHOOK_SIGNING_SECRET;
});

describe('POST /api/webhooks/pms/rukiye-zara', () => {
  it.each([
    'reservation.confirmed',
    'reservation.updated',
    'reservation.cancelled',
  ])('accepts a valid signed %s event', async (type) => {
    const rawBody = JSON.stringify({ ...BASE_EVENT, type });

    const response = await POST(request(rawBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      event_id: BASE_EVENT.id,
      status: 'received',
    });
    expect(h.processEvent).toHaveBeenCalledWith({
      ...BASE_EVENT,
      type,
      property_id: '22008',
    });
  });

  it('rejects a missing timestamp header', async () => {
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(request(rawBody, { timestamp: null }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_signature',
    });
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing signature header', async () => {
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(request(rawBody, { signature: null }));

    expect(response.status).toBe(401);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('rejects a malformed v1 signature', async () => {
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(
      request(rawBody, { signature: `v1=${'G'.repeat(64)}` })
    );

    expect(response.status).toBe(401);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('rejects a non-integer timestamp header', async () => {
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(
      request(rawBody, { timestamp: `${NOW}.5` })
    );

    expect(response.status).toBe(401);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('rejects a stale timestamp', async () => {
    const rawBody = JSON.stringify(BASE_EVENT);
    const stale = NOW - 301;

    const response = await POST(
      request(rawBody, {
        timestamp: String(stale),
        signature: signature(rawBody, stale),
      })
    );

    expect(response.status).toBe(401);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('rejects the wrong HMAC', async () => {
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(
      request(rawBody, { signature: `v1=${'0'.repeat(64)}` })
    );

    expect(response.status).toBe(401);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('rejects authenticated malformed JSON', async () => {
    const rawBody = '{"id":';

    const response = await POST(request(rawBody));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });

  it('rejects a malformed event envelope', async () => {
    const rawBody = JSON.stringify({
      ...BASE_EVENT,
      resource: { type: 'reservation', id: '' },
    });

    const response = await POST(request(rawBody));

    expect(response.status).toBe(400);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('requires reservation events to identify a reservation resource', async () => {
    const rawBody = JSON.stringify({
      ...BASE_EVENT,
      resource: { type: 'property', id: 'RZ-RES-9001' },
    });

    const response = await POST(request(rawBody));

    expect(response.status).toBe(400);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('accepts the deployed envelope with a null source', async () => {
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(request(rawBody));

    expect(response.status).toBe(200);
    expect(h.processEvent).toHaveBeenCalledWith({
      ...BASE_EVENT,
      property_id: '22008',
    });
  });

  it('normalizes a numeric property_id before processing', async () => {
    const rawBody = JSON.stringify({ ...BASE_EVENT, property_id: 22008 });

    await POST(request(rawBody));

    expect(h.processEvent).toHaveBeenCalledWith(
      expect.objectContaining({ property_id: '22008' })
    );
  });

  it('allows future top-level envelope fields', async () => {
    const rawBody = JSON.stringify({
      ...BASE_EVENT,
      future_delivery_attempt: 2,
    });

    const response = await POST(request(rawBody));

    expect(response.status).toBe(200);
    expect(h.processEvent).toHaveBeenCalledOnce();
  });

  it('acknowledges an authenticated unsupported event without processing', async () => {
    const rawBody = JSON.stringify({
      ...BASE_EVENT,
      type: 'reservation.deleted_forever',
    });

    const response = await POST(request(rawBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      ignored: true,
      reason: 'unsupported_event',
    });
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('returns a safe conflict for an unknown or disconnected property', async () => {
    h.processEvent.mockRejectedValue(
      new PmsWebhookProcessingError('property_not_connected')
    );
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(request(rawBody));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'property_not_connected',
    });
  });

  it('acknowledges a duplicate event', async () => {
    h.processEvent.mockResolvedValue({
      duplicate: true,
      accountId: 'workspace-1',
      integrationId: 'integration-1',
      propertyId: 'property-1',
    });
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(request(rawBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
  });

  it('verifies the exact raw body rather than re-serialized JSON', async () => {
    const compact = JSON.stringify(BASE_EVENT);
    const rawBody = JSON.stringify(BASE_EVENT, null, 2);

    const response = await POST(
      request(rawBody, { signature: signature(compact) })
    );

    expect(response.status).toBe(401);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it('fails securely when the signing secret is missing', async () => {
    delete process.env.RZ_PMS_WEBHOOK_SIGNING_SECRET;
    const rawBody = JSON.stringify(BASE_EVENT);

    const response = await POST(request(rawBody));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'invalid_signature',
    });
    expect(h.processEvent).not.toHaveBeenCalled();
  });
});
