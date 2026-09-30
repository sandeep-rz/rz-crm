import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runPendingExecutionWorker } from '@/lib/automations/pending-worker'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * Claims are atomic and bounded in Postgres. Stale leases are recoverable,
 * and failures are retried independently without aborting the batch.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    return NextResponse.json(await runPendingExecutionWorker())
  } catch (error) {
    console.error('[automations] pending worker failed', error)
    return NextResponse.json(
      { error: 'pending automation worker failed' },
      { status: 500 },
    )
  }
}
