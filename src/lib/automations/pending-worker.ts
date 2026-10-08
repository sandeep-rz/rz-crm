import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from './admin-client';
import { resumePendingExecution, type AutomationContext } from './engine';

export const PENDING_BATCH_SIZE = 50;
export const PENDING_LEASE_MS = 15 * 60 * 1000;
export const PENDING_MAX_ATTEMPTS = 5;
const BASE_RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;

export interface PendingExecutionRow {
  id: string;
  automation_id: string;
  account_id: string;
  user_id: string;
  contact_id: string | null;
  log_id: string | null;
  parent_step_id: string | null;
  branch: 'yes' | 'no' | null;
  next_step_position: number;
  context: AutomationContext | null;
  attempt_count: number;
}

interface PendingWorkerDependencies {
  db?: SupabaseClient;
  now?: Date;
  resume?: typeof resumePendingExecution;
}

export interface PendingWorkerResult {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

export function pendingRetryDelayMs(attemptCount: number): number {
  return Math.min(
    BASE_RETRY_MS * 2 ** Math.max(0, attemptCount - 1),
    MAX_RETRY_MS
  );
}

export async function runPendingExecutionWorker(
  dependencies: PendingWorkerDependencies = {}
): Promise<PendingWorkerResult> {
  const db = dependencies.db ?? supabaseAdmin();
  const resume = dependencies.resume ?? resumePendingExecution;
  const now = dependencies.now ?? new Date();
  const { data, error } = await db.rpc('claim_automation_pending_executions', {
    p_batch_size: PENDING_BATCH_SIZE,
    p_now: now.toISOString(),
    p_stale_before: new Date(now.getTime() - PENDING_LEASE_MS).toISOString(),
    p_max_attempts: PENDING_MAX_ATTEMPTS,
  });
  if (error)
    throw new Error(`cannot claim pending automations: ${error.message}`);

  const rows = (data ?? []) as PendingExecutionRow[];
  const result: PendingWorkerResult = {
    claimed: rows.length,
    completed: 0,
    retried: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      await resume({ ...row, context: row.context ?? {} });
      result.completed++;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Preserve the Wait cursor/queue, but never replay an uncertain segment.
      let unsafe = true;
      try {
        if (row.log_id) {
          const { data: log, error: safetyError } = await db
            .from('automation_logs')
            .select('completed_wait_continuation_ids')
            .eq('id', row.log_id)
            .eq('account_id', row.account_id)
            .single();
          if (safetyError || !log) unsafe = true;
          else if ((log.completed_wait_continuation_ids ?? []).includes(row.id))
            unsafe = false;
          else {
            const { data: pending, error: pendingError } = await db
              .from('automation_pending_executions')
              .select('context')
              .eq('id', row.id)
              .eq('account_id', row.account_id)
              .eq('log_id', row.log_id)
              .single();
            unsafe = Boolean(
              pendingError || !pending || pending.context?.__retry_safety
            );
          }
        }
      } catch {
        unsafe = true;
      }
      const terminal = unsafe || row.attempt_count >= PENDING_MAX_ATTEMPTS;
      const update = terminal
        ? {
            status: 'failed',
            processing_started_at: null,
            next_attempt_at: null,
            last_error: message.slice(0, 1000),
          }
        : {
            status: 'pending',
            processing_started_at: null,
            next_attempt_at: new Date(
              now.getTime() + pendingRetryDelayMs(row.attempt_count)
            ).toISOString(),
            last_error: message.slice(0, 1000),
          };
      const { error: updateError } = await db
        .from('automation_pending_executions')
        .update(update)
        .eq('id', row.id)
        .eq('status', 'running')
        .eq('attempt_count', row.attempt_count);
      if (updateError) {
        console.error(
          '[automations] continuation failure state update failed',
          {
            pendingExecutionId: row.id,
            automationId: row.automation_id,
            attempt: row.attempt_count,
            terminal,
            error: updateError.message,
          }
        );
      }
      console.error('[automations] continuation failed', {
        pendingExecutionId: row.id,
        automationId: row.automation_id,
        attempt: row.attempt_count,
        state: terminal ? 'failed' : 'retry_scheduled',
        error: message.slice(0, 1000),
      });
      if (terminal) result.failed++;
      else result.retried++;
    }
  }

  return result;
}
