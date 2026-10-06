import { MetaApiError } from './meta-api';

/** No raw response, request payload, token or approval samples enter logs. */
export function templateSubmitError(error: unknown, accessToken: string) {
  const safe = (text: string | null): string | null => {
    if (typeof text !== 'string') return null;
    const redacted = accessToken
      ? text.split(accessToken).join('[redacted]')
      : text;
    return redacted
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/access_token=[^\s&]+/gi, 'access_token=[redacted]')
      .slice(0, 2000);
  };
  const meta =
    error instanceof MetaApiError
      ? {
          code: error.code,
          error_subcode: error.subcode,
          type: safe(error.type),
          error_user_title: safe(error.userTitle),
          error_user_msg: safe(error.userMessage),
          fbtrace_id: safe(error.fbtraceId),
          http_status: error.httpStatus,
        }
      : null;
  const message = safe(
    error instanceof Error ? error.message : 'Meta submit failed.'
  )!;
  const useful =
    meta?.error_user_msg ||
    (error instanceof MetaApiError ? safe(error.details) : null);
  return {
    message: useful ? `${message}: ${useful}` : message,
    diagnostic: meta,
    stored: [
      useful ? `${message}: ${useful}` : message,
      meta ? JSON.stringify(meta) : null,
    ]
      .filter(Boolean)
      .join('\n'),
    rateLimited:
      error instanceof MetaApiError
        ? error.httpStatus === 429 || error.code === 4 || error.code === 80007
        : /\b429\b/.test(message),
  };
}
