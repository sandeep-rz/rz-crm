import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  Automation,
  PmsAutomationTriggerType,
  PmsTriggerConfig,
} from '@/types';
import { supabaseAdmin } from './admin-client';
import { runAutomationForTrigger } from './engine';
import {
  loadReservationAutomationContext,
  reservationContextVars,
  type ReservationAutomationContext,
} from './pms-context';
import {
  computeScheduledRunAt,
  matchesReservationTriggerConfig,
  PMS_SCHEDULED_AUTOMATION_TRIGGERS,
} from './pms-scheduler';

export const PMS_AUTOMATION_JOB_BATCH_SIZE = 10;
export const PMS_AUTOMATION_JOB_STALE_MS = 15 * 60 * 1000;
export const PMS_AUTOMATION_JOB_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface AutomationTriggerJobClaim {
  id: string;
  accountId: string;
  automationId: string;
  reservationId: string;
  webhookEventId: string | null;
  triggerType: PmsAutomationTriggerType;
  runAt: string;
  processingStartedAt: string;
  attemptCount: number;
}

export interface PmsAutomationJobStore {
  claimJobs(input: {
    limit: number;
    now: string;
    staleBefore: string;
  }): Promise<AutomationTriggerJobClaim[]>;
  findCompletedExecution(
    job: AutomationTriggerJobClaim
  ): Promise<{ logId: string } | null>;
  retryBlockReason(job: AutomationTriggerJobClaim): Promise<string | null>;
  loadAutomation(job: AutomationTriggerJobClaim): Promise<Automation | null>;
  markCompleted(
    job: AutomationTriggerJobClaim,
    completedAt: string
  ): Promise<void>;
  markSuppressed(
    job: AutomationTriggerJobClaim,
    completedAt: string,
    reason: string
  ): Promise<void>;
  markRescheduled(
    job: AutomationTriggerJobClaim,
    runAt: string,
    reason: string
  ): Promise<void>;
  markFailed(
    job: AutomationTriggerJobClaim,
    input: {
      error: string;
      retryable: boolean;
      nextAttemptAt: string | null;
      completedAt: string | null;
    }
  ): Promise<void>;
}

export class PmsAutomationJobError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'PmsAutomationJobError';
  }
}

function retryAt(attemptCount: number, now: Date): string | null {
  if (attemptCount >= PMS_AUTOMATION_JOB_MAX_ATTEMPTS) return null;
  const delay =
    RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)];
  return new Date(now.getTime() + delay).toISOString();
}

function isCancelled(status: string): boolean {
  return ['cancelled', 'canceled'].includes(status.toLowerCase());
}

export async function processPmsAutomationJob(
  job: AutomationTriggerJobClaim,
  dependencies: {
    store?: PmsAutomationJobStore;
    loadContext?: typeof loadReservationAutomationContext;
    dispatch?: typeof runAutomationForTrigger;
    now?: () => Date;
  } = {}
): Promise<
  'completed' | 'failed' | 'suppressed' | 'rescheduled' | 'inProgress'
> {
  const store = dependencies.store ?? new SupabasePmsAutomationJobStore();
  const loadContext =
    dependencies.loadContext ?? loadReservationAutomationContext;
  const dispatch = dependencies.dispatch ?? runAutomationForTrigger;
  const now = dependencies.now ?? (() => new Date());

  try {
    // Crash recovery fast path: the existing automation execution is the
    // durable source of truth. A stale job lease must not replay its steps
    // after that unique execution already reached success/partial.
    const completedExecution = await store.findCompletedExecution(job);
    if (completedExecution) {
      await store.markCompleted(job, now().toISOString());
      return 'completed';
    }

    if (await store.retryBlockReason(job))
      throw new PmsAutomationJobError('unsafe_to_retry', false);

    const automation = await store.loadAutomation(job);
    if (!automation) {
      throw new PmsAutomationJobError(
        'Automation/account relationship is invalid.',
        false
      );
    }
    if (!automation.is_active) {
      await store.markSuppressed(
        job,
        now().toISOString(),
        'Automation is inactive.'
      );
      return 'suppressed';
    }
    if (automation.trigger_type !== job.triggerType) {
      throw new PmsAutomationJobError(
        'Automation trigger no longer matches the job.',
        false
      );
    }

    const reservation = await loadContext(job.reservationId, job.accountId);
    if (!reservation || reservation.account_id !== job.accountId) {
      throw new PmsAutomationJobError(
        'Reservation/account relationships are invalid.',
        false
      );
    }
    if (
      !matchesReservationTriggerConfig(
        automation.trigger_config as PmsTriggerConfig,
        reservation
      )
    ) {
      await store.markSuppressed(
        job,
        now().toISOString(),
        'Reservation no longer matches trigger filters.'
      );
      return 'suppressed';
    }
    if (
      job.triggerType !== 'reservation_cancelled' &&
      isCancelled(reservation.reservation_status)
    ) {
      await store.markSuppressed(
        job,
        now().toISOString(),
        'Reservation is cancelled.'
      );
      return 'suppressed';
    }

    if (
      PMS_SCHEDULED_AUTOMATION_TRIGGERS.includes(
        job.triggerType as (typeof PMS_SCHEDULED_AUTOMATION_TRIGGERS)[number]
      )
    ) {
      const expectedRunAt = computeScheduledRunAt(
        job.triggerType,
        automation.trigger_config as PmsTriggerConfig,
        reservation
      );
      if (!expectedRunAt) {
        throw new PmsAutomationJobError(
          'Scheduled trigger configuration is invalid.',
          false
        );
      }
      if (Date.parse(expectedRunAt) > now().getTime()) {
        await store.markRescheduled(
          job,
          expectedRunAt,
          'Reservation schedule changed.'
        );
        return 'rescheduled';
      }
    }

    const execution = await dispatch(
      automation.id,
      {
        accountId: job.accountId,
        triggerType: job.triggerType,
        contactId: reservation.contact_id,
        context: {
          reservation,
          vars: reservationContextVars(reservation),
        },
      },
      {
        triggerJobId: job.id,
        attemptCount: job.attemptCount,
        expectedReservationUpdatedAt: reservation.reservation_updated_at,
      }
    );
    if (!execution) {
      await store.markSuppressed(
        job,
        now().toISOString(),
        'Automation is no longer eligible.'
      );
      return 'suppressed';
    }
    if (execution.disposition === 'already_running') {
      // A duplicate invocation of the same current claim does not own the
      // execution and must not mutate the job underneath the first worker.
      return 'inProgress';
    }
    if (execution.disposition === 'reservation_changed') {
      await store.markSuppressed(
        job,
        now().toISOString(),
        'Reservation changed after eligibility validation.'
      );
      return 'suppressed';
    }
    if (execution.disposition === 'ineligible') {
      await store.markSuppressed(
        job,
        now().toISOString(),
        'Automation is no longer eligible.'
      );
      return 'suppressed';
    }
    if (execution.status === 'failed') {
      throw new PmsAutomationJobError(
        execution.errorMessage ?? 'Automation execution failed.',
        execution.retryable ?? true
      );
    }
    await store.markCompleted(job, now().toISOString());
    return 'completed';
  } catch (error) {
    let retryable =
      error instanceof PmsAutomationJobError ? error.retryable : true;
    // Re-read durable evidence even when the executor crashed/threw before returning a result.
    try {
      if (await store.retryBlockReason(job)) retryable = false;
    } catch {
      retryable = false; // Cannot prove that restarting is safe.
    }
    const message =
      error instanceof Error ? error.message : 'PMS automation job failed.';
    const nextAttemptAt = retryable ? retryAt(job.attemptCount, now()) : null;
    const canRetry = retryable && nextAttemptAt !== null;
    await store.markFailed(job, {
      error: message.slice(0, 500),
      retryable: canRetry,
      nextAttemptAt,
      completedAt: canRetry ? null : now().toISOString(),
    });
    return 'failed';
  }
}

export async function runPmsAutomationJobWorker(
  dependencies: Parameters<typeof processPmsAutomationJob>[1] & {
    store?: PmsAutomationJobStore;
    limit?: number;
  } = {}
) {
  const store = dependencies.store ?? new SupabasePmsAutomationJobStore();
  const now = dependencies.now ?? (() => new Date());
  const claimTime = now();
  const jobs = await store.claimJobs({
    limit: dependencies.limit ?? PMS_AUTOMATION_JOB_BATCH_SIZE,
    now: claimTime.toISOString(),
    staleBefore: new Date(
      claimTime.getTime() - PMS_AUTOMATION_JOB_STALE_MS
    ).toISOString(),
  });
  const summary = {
    claimed: jobs.length,
    completed: 0,
    failed: 0,
    suppressed: 0,
    rescheduled: 0,
    inProgress: 0,
  };
  for (const job of jobs) {
    try {
      const result = await processPmsAutomationJob(job, {
        ...dependencies,
        store,
        now,
      });
      summary[result] += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

export class SupabasePmsAutomationJobStore implements PmsAutomationJobStore {
  constructor(private readonly db: SupabaseClient = supabaseAdmin()) {}

  async claimJobs(input: { limit: number; now: string; staleBefore: string }) {
    const { data, error } = await this.db.rpc('claim_automation_trigger_jobs', {
      p_limit: input.limit,
      p_now: input.now,
      p_stale_before: input.staleBefore,
    });
    if (error)
      throw new PmsAutomationJobError('Automation job claim failed.', true);
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: row.job_id as string,
      accountId: row.account_id as string,
      automationId: row.automation_id as string,
      reservationId: row.pms_reservation_id as string,
      webhookEventId: row.pms_webhook_event_id as string | null,
      triggerType: row.trigger_type as PmsAutomationTriggerType,
      runAt: row.run_at as string,
      processingStartedAt: row.processing_started_at as string,
      attemptCount: row.attempt_count as number,
    }));
  }

  async retryBlockReason(job: AutomationTriggerJobClaim) {
    const { data, error } = await this.db.rpc('automation_retry_block_reason', {
      p_job_id: job.id,
      p_account_id: job.accountId,
    });
    if (error)
      throw new PmsAutomationJobError('Retry safety lookup failed.', false);
    return data as string | null;
  }

  async loadAutomation(job: AutomationTriggerJobClaim) {
    const { data, error } = await this.db
      .from('automations')
      .select('*')
      .eq('id', job.automationId)
      .eq('account_id', job.accountId)
      .maybeSingle();
    if (error)
      throw new PmsAutomationJobError('Automation lookup failed.', true);
    return data as Automation | null;
  }

  async findCompletedExecution(job: AutomationTriggerJobClaim) {
    const { data, error } = await this.db
      .from('automation_logs')
      .select('id')
      .eq('trigger_job_id', job.id)
      .eq('account_id', job.accountId)
      .eq('automation_id', job.automationId)
      .eq('trigger_job_execution_state', 'completed')
      .maybeSingle();
    if (error) {
      throw new PmsAutomationJobError(
        'Automation execution recovery lookup failed.',
        true
      );
    }
    return data ? { logId: data.id as string } : null;
  }

  private async updateClaim(
    job: AutomationTriggerJobClaim,
    patch: Record<string, unknown>
  ) {
    const { error } = await this.db
      .from('automation_trigger_jobs')
      .update(patch)
      .eq('id', job.id)
      .eq('account_id', job.accountId)
      .eq('status', 'processing')
      .eq('attempt_count', job.attemptCount);
    if (error)
      throw new PmsAutomationJobError(
        'Automation job state update failed.',
        true
      );
  }

  async markCompleted(job: AutomationTriggerJobClaim, completedAt: string) {
    await this.updateClaim(job, {
      status: 'completed',
      processing_started_at: null,
      retryable: false,
      next_attempt_at: null,
      last_error: null,
      completed_at: completedAt,
    });
  }

  async markSuppressed(
    job: AutomationTriggerJobClaim,
    completedAt: string,
    reason: string
  ) {
    await this.updateClaim(job, {
      status: 'suppressed',
      processing_started_at: null,
      retryable: false,
      next_attempt_at: null,
      last_error: reason,
      completed_at: completedAt,
    });
  }

  async markRescheduled(
    job: AutomationTriggerJobClaim,
    runAt: string,
    reason: string
  ) {
    await this.updateClaim(job, {
      status: 'scheduled',
      run_at: runAt,
      processing_started_at: null,
      retryable: false,
      next_attempt_at: null,
      last_error: reason,
      completed_at: null,
    });
  }

  async markFailed(
    job: AutomationTriggerJobClaim,
    input: {
      error: string;
      retryable: boolean;
      nextAttemptAt: string | null;
      completedAt: string | null;
    }
  ) {
    await this.updateClaim(job, {
      status: 'failed',
      processing_started_at: null,
      retryable: input.retryable,
      next_attempt_at: input.nextAttemptAt,
      last_error: input.error,
      completed_at: input.completedAt,
    });
  }
}

export type { ReservationAutomationContext };
