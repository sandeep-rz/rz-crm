import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutomationLog } from '@/types';
import { supabaseAdmin } from './admin-client';

export type ManualRetryState =
  | 'queued'
  | 'already_completed'
  | 'already_retried'
  | 'not_found'
  | 'not_failed'
  | 'unsafe_to_retry';
export type ActivityRetryState =
  'eligible' | 'already_completed' | 'already_retried' | 'not_eligible';
export type ActivityFailureReason =
  | 'connection'
  | 'template'
  | 'variables'
  | 'reservation'
  | 'recipient'
  | 'templateSend'
  | 'generic';
export interface RetryActivityLog extends Pick<
  AutomationLog,
  | 'id'
  | 'status'
  | 'created_at'
  | 'trigger_event'
  | 'trigger_job_id'
  | 'trigger_job_attempt_count'
  | 'trigger_job_execution_state'
> {
  manual_retry_state?: ActivityRetryState;
  contact?: { name: string | null; phone: string | null } | null;
  reservation_reference?: string | null;
  job_status?: string;
  job_attempt_count?: number;
  failure_reason?: ActivityFailureReason;
  steps_executed: {
    step_type: string;
    status: 'success' | 'failed' | 'skipped';
    failure_reason?: ActivityFailureReason;
  }[];
}
export class ManualRetryError extends Error {
  constructor(readonly code: ManualRetryState | 'retry_unavailable') {
    super(code);
  }
}
export const validExecutionId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** Only requeue. Current execution validation belongs to the existing worker. */
export async function retryPmsAutomationExecution(
  accountId: string,
  logId: string,
  db: SupabaseClient = supabaseAdmin()
): Promise<'queued'> {
  const { data, error } = await db.rpc('retry_pms_automation_execution', {
    p_log_id: logId,
    p_account_id: accountId,
  });
  if (error) throw new ManualRetryError('retry_unavailable');
  if (data === 'queued') return 'queued';
  if (
    [
      'already_completed',
      'already_retried',
      'not_found',
      'not_failed',
      'unsafe_to_retry',
    ].includes(data)
  )
    throw new ManualRetryError(data as ManualRetryState);
  throw new ManualRetryError('retry_unavailable');
}
