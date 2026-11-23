export interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  expires_at: string;
}

export const PEEK_FAIL_REASONS = [
  'not_found',
  'used',
  'expired',
  'rate_limited',
  'server_error',
] as const;

export type PeekFailReason = (typeof PEEK_FAIL_REASONS)[number];

export interface PeekFail {
  ok: false;
  reason: PeekFailReason;
}

export type PeekResult = PeekOk | PeekFail;

export const RETRYABLE_PEEK_FAIL_REASONS: ReadonlySet<PeekFailReason> = new Set(
  ['rate_limited', 'server_error']
);

function isPeekFailReason(value: unknown): value is PeekFailReason {
  return (
    typeof value === 'string' &&
    (PEEK_FAIL_REASONS as readonly string[]).includes(value)
  );
}

export function toPeekResult(status: number, body: unknown): PeekResult {
  if (status === 429) return { ok: false, reason: 'rate_limited' };
  if (status >= 500 || status < 200)
    return { ok: false, reason: 'server_error' };
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const payload = body as Record<string, unknown>;
    if (
      status < 300 &&
      payload.ok === true &&
      typeof payload.account_name === 'string' &&
      payload.account_name.trim() &&
      ['admin', 'agent', 'viewer'].includes(String(payload.role)) &&
      typeof payload.expires_at === 'string' &&
      Number.isFinite(Date.parse(payload.expires_at))
    )
      return {
        ok: true,
        account_name: payload.account_name,
        role: payload.role as PeekOk['role'],
        expires_at: payload.expires_at,
      };
    if (payload.ok === false && isPeekFailReason(payload.reason)) {
      return { ok: false, reason: payload.reason };
    }
  }
  return { ok: false, reason: 'server_error' };
}
