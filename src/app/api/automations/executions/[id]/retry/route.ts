import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  retryPmsAutomationExecution,
  ManualRetryError,
  validExecutionId,
} from '@/lib/automations/manual-retry';
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let account;
  try {
    account = await requireRole('agent');
  } catch (error) {
    return toErrorResponse(error);
  }
  const { id } = await params;
  if (!validExecutionId(id))
    return NextResponse.json(
      { code: 'not_found', error: 'Execution not found.' },
      { status: 404 }
    );
  try {
    await retryPmsAutomationExecution(account.accountId, id);
    return NextResponse.json({ status: 'queued' }, { status: 202 });
  } catch (error) {
    const code =
      error instanceof ManualRetryError ? error.code : 'retry_unavailable';
    return NextResponse.json(
      {
        code,
        error:
          code === 'unsafe_to_retry'
            ? 'Retry unavailable because this execution may already have performed an external action.'
            : code === 'retry_unavailable'
              ? 'Unable to queue this execution.'
              : 'This execution cannot be retried.',
      },
      {
        status:
          code === 'not_found' ? 404 : code === 'retry_unavailable' ? 503 : 409,
      }
    );
  }
}
