import { NextResponse } from 'next/server';

import {
  isSupportedRzPmsEvent,
  validateRzPmsWebhookEnvelope,
} from '@/lib/integrations/pms/webhooks/envelope';
import {
  PmsWebhookProcessingError,
  processRzPmsWebhookEvent,
} from '@/lib/integrations/pms/webhooks/processor';
import {
  RZ_PMS_SIGNATURE_HEADER,
  RZ_PMS_TIMESTAMP_HEADER,
  verifyRukiyeZaraWebhookSignature,
} from '@/lib/integrations/pms/webhooks/signature';

export const runtime = 'nodejs';

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
      return response({ ok: false, error: 'invalid_request' }, 400);
    }

    const timestamp = request.headers.get(RZ_PMS_TIMESTAMP_HEADER);
    const signature = request.headers.get(RZ_PMS_SIGNATURE_HEADER);
    const verification = verifyRukiyeZaraWebhookSignature(
      rawBody,
      timestamp,
      signature
    );
    if (!verification.ok) {
      if (verification.reason === 'secret_missing') {
        console.error(
          '[RZ PMS webhook] signing secret is not configured; request rejected'
        );
      }
      return response({ ok: false, error: 'invalid_signature' }, 401);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return response({ ok: false, error: 'invalid_request' }, 400);
    }

    const validation = validateRzPmsWebhookEnvelope(parsed);
    if (!validation.success) {
      return response({ ok: false, error: 'invalid_request' }, 400);
    }

    const event = validation.data;
    if (!isSupportedRzPmsEvent(event.type)) {
      return response(
        { ok: true, ignored: true, reason: 'unsupported_event' },
        200
      );
    }

    try {
      const result = await processRzPmsWebhookEvent(event);
      if (result.duplicate) {
        return response({ ok: true, duplicate: true }, 200);
      }
      return response(
        { ok: true, event_id: event.id, status: 'received' },
        200
      );
    } catch (error) {
      if (
        error instanceof PmsWebhookProcessingError &&
        error.code === 'property_not_connected'
      ) {
        console.warn('[RZ PMS webhook] property mapping unavailable', {
          event_id: event.id,
          external_property_id: event.property_id,
        });
        return response({ ok: false, error: 'property_not_connected' }, 409);
      }
      throw error;
    }
  } catch {
    // Never log the request, signature, raw body, database error, or secret.
    console.error('[RZ PMS webhook] processing failed');
    return response({ ok: false, error: 'webhook_processing_failed' }, 500);
  }
}
