import { createHmac, timingSafeEqual } from 'node:crypto';

export const RZ_PMS_TIMESTAMP_HEADER = 'x-rz-timestamp';
export const RZ_PMS_SIGNATURE_HEADER = 'x-rz-signature';
export const RZ_PMS_SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureVerificationFailure =
  | 'secret_missing'
  | 'signature_missing'
  | 'timestamp_missing'
  | 'signature_malformed'
  | 'timestamp_stale'
  | 'signature_invalid';

export type SignatureVerificationResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: SignatureVerificationFailure };

function parseSignatureHeaders(
  timestampHeader: string | null,
  signatureHeader: string | null
): { timestamp: number; signature: string } | SignatureVerificationResult {
  if (!timestampHeader) return { ok: false, reason: 'timestamp_missing' };
  if (!signatureHeader) return { ok: false, reason: 'signature_missing' };
  if (!/^\d+$/.test(timestampHeader)) {
    return { ok: false, reason: 'signature_malformed' };
  }

  const signatureMatch = /^v1=([0-9a-f]{64})$/.exec(signatureHeader);
  if (!signatureMatch) return { ok: false, reason: 'signature_malformed' };

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    return { ok: false, reason: 'signature_malformed' };
  }

  return { timestamp, signature: signatureMatch[1] };
}

export function verifyRukiyeZaraWebhookSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
  secret = process.env.RZ_PMS_WEBHOOK_SIGNING_SECRET
): SignatureVerificationResult {
  if (!secret) return { ok: false, reason: 'secret_missing' };

  const parsed = parseSignatureHeaders(timestampHeader, signatureHeader);
  if ('ok' in parsed) return parsed;

  if (
    Math.abs(nowSeconds - parsed.timestamp) > RZ_PMS_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return { ok: false, reason: 'timestamp_stale' };
  }

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest();
  const supplied = Buffer.from(parsed.signature, 'hex');

  if (expected.length !== supplied.length) {
    return { ok: false, reason: 'signature_invalid' };
  }
  if (!timingSafeEqual(expected, supplied)) {
    return { ok: false, reason: 'signature_invalid' };
  }

  return { ok: true, timestamp: parsed.timestamp };
}
