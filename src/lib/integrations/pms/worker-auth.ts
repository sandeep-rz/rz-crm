import { timingSafeEqual } from 'node:crypto';

export const PMS_SYNC_WORKER_TOKEN_HEADER = 'x-pms-sync-worker-token';

export type PmsWorkerAuthorization =
  'authorized' | 'not_configured' | 'unauthorized';

export function authorizePmsWorkerRequest(
  request: Request,
  expectedToken = process.env.PMS_SYNC_WORKER_TOKEN
): PmsWorkerAuthorization {
  if (!expectedToken) return 'not_configured';

  const supplied = request.headers.get(PMS_SYNC_WORKER_TOKEN_HEADER) ?? '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedToken);

  return suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
    ? 'authorized'
    : 'unauthorized';
}
