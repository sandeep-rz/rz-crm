import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  Automation,
  PmsAutomationTriggerType,
  PmsTriggerConfig,
} from '@/types';
import { supabaseAdmin } from './admin-client';
import {
  computeScheduledRunAt,
  isReservationEligibleForTiming,
  matchesReservationTriggerConfig,
  parsePmsScheduleUpsertResult,
  scheduledOccurrenceKey,
  type AutomationTriggerJobInsert,
  type ReservationSchedulingContext,
} from './pms-scheduler';
import { isPmsScheduledAutomationTrigger } from './pms-trigger-schema';

const DEFAULT_BATCH_SIZE = 250;

export interface PmsScheduleBackfillResult {
  scannedReservations: number;
  scheduledJobs: number;
}

interface ReservationBatchInput {
  accountId: string;
  triggerType: PmsAutomationTriggerType;
  triggerConfig: PmsTriggerConfig;
  cursor: string | null;
  limit: number;
  now: Date;
}

export interface PmsScheduleBackfillStore {
  loadAutomation(automationId: string): Promise<Automation | null>;
  loadReservationBatch(
    input: ReservationBatchInput
  ): Promise<ReservationSchedulingContext[]>;
  upsertScheduledJobs(jobs: AutomationTriggerJobInsert[]): Promise<number>;
  cancelFutureJobsForAutomation(input: {
    automationId: string;
    accountId: string;
    now: string;
    reason: string;
  }): Promise<number>;
}

export class PmsScheduleBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmsScheduleBackfillError';
  }
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** A coarse safe lower bound; exact eligibility is still decided in UTC below. */
export function earliestRelevantDate(
  triggerType: PmsAutomationTriggerType,
  config: PmsTriggerConfig,
  now: Date
): string {
  const utcToday = now.toISOString().slice(0, 10);
  if (triggerType === 'before_checkin') {
    return addUtcDays(utcToday, Number(config.days_before ?? 0) - 1);
  }
  if (triggerType === 'after_checkout') {
    return addUtcDays(utcToday, -Number(config.days_after ?? 0) - 1);
  }
  return addUtcDays(utcToday, -1);
}

export async function backfillPmsAutomationSchedules(
  automationId: string,
  dependencies: {
    store?: PmsScheduleBackfillStore;
    now?: () => Date;
    batchSize?: number;
    allowInactiveActivation?: boolean;
  } = {}
): Promise<PmsScheduleBackfillResult> {
  const store = dependencies.store ?? new SupabasePmsScheduleBackfillStore();
  const now = dependencies.now ?? (() => new Date());
  const batchSize = dependencies.batchSize ?? DEFAULT_BATCH_SIZE;
  const automation = await store.loadAutomation(automationId);
  const result = { scannedReservations: 0, scheduledJobs: 0 };

  if (
    !automation ||
    (!automation.is_active && !dependencies.allowInactiveActivation) ||
    !isPmsScheduledAutomationTrigger(automation.trigger_type)
  ) {
    return result;
  }

  const triggerType = automation.trigger_type;
  const triggerConfig = automation.trigger_config as PmsTriggerConfig;
  const currentTime = now();
  let cursor: string | null = null;

  for (;;) {
    const reservations = await store.loadReservationBatch({
      accountId: automation.account_id,
      triggerType,
      triggerConfig,
      cursor,
      limit: batchSize,
      now: currentTime,
    });
    if (reservations.length === 0) break;
    result.scannedReservations += reservations.length;
    const jobs: AutomationTriggerJobInsert[] = [];

    for (const reservation of reservations) {
      if (
        reservation.account_id !== automation.account_id ||
        !isReservationEligibleForTiming(reservation) ||
        !matchesReservationTriggerConfig(triggerConfig, reservation)
      ) {
        continue;
      }
      const runAt = computeScheduledRunAt(
        triggerType,
        triggerConfig,
        reservation
      );
      if (!runAt || Date.parse(runAt) <= currentTime.getTime()) continue;

      jobs.push({
        account_id: automation.account_id,
        automation_id: automation.id,
        pms_reservation_id: reservation.reservation_id,
        pms_webhook_event_id: null,
        trigger_type: triggerType,
        occurrence_key: scheduledOccurrenceKey({
          automationId: automation.id,
          reservationId: reservation.reservation_id,
          triggerType,
        }),
        run_at: runAt,
        source_updated_at: reservation.reservation_updated_at ?? null,
      });
    }
    if (jobs.length > 0) {
      result.scheduledJobs += await store.upsertScheduledJobs(jobs);
    }

    cursor = reservations.at(-1)!.reservation_id;
    if (reservations.length < batchSize) break;
  }

  return result;
}

export async function cancelFuturePmsAutomationSchedules(
  input: {
    automationId: string;
    accountId: string;
    reason: string;
  },
  dependencies: {
    store?: PmsScheduleBackfillStore;
    now?: () => Date;
  } = {}
): Promise<number> {
  const store = dependencies.store ?? new SupabasePmsScheduleBackfillStore();
  const now = dependencies.now ?? (() => new Date());
  return store.cancelFutureJobsForAutomation({
    ...input,
    now: now().toISOString(),
  });
}

export class SupabasePmsScheduleBackfillStore implements PmsScheduleBackfillStore {
  constructor(private readonly db: SupabaseClient = supabaseAdmin()) {}

  async loadAutomation(automationId: string): Promise<Automation | null> {
    const { data, error } = await this.db
      .from('automations')
      .select('*')
      .eq('id', automationId)
      .maybeSingle();
    if (error) throw new PmsScheduleBackfillError('Automation lookup failed.');
    return data as Automation | null;
  }

  async loadReservationBatch(
    input: ReservationBatchInput
  ): Promise<ReservationSchedulingContext[]> {
    const dateField =
      input.triggerType === 'after_checkout' ? 'check_out' : 'check_in';
    let query = this.db
      .from('pms_reservations')
      .select(
        'id, account_id, pms_property_id, status, channel_code, check_in, check_out, updated_at'
      )
      .eq('account_id', input.accountId)
      .not(dateField, 'is', null)
      .gte(
        dateField,
        earliestRelevantDate(input.triggerType, input.triggerConfig, input.now)
      )
      .order('id', { ascending: true })
      .limit(input.limit);
    const propertyIds = Array.isArray(input.triggerConfig.property_ids)
      ? input.triggerConfig.property_ids
      : input.triggerConfig.property_id
        ? [input.triggerConfig.property_id]
        : [];
    if (propertyIds.length > 0) {
      query = query.in('pms_property_id', propertyIds);
    }
    if ((input.triggerConfig.channels?.length ?? 0) > 0) {
      query = query.in('channel_code', input.triggerConfig.channels!);
    }
    if ((input.triggerConfig.reservation_statuses?.length ?? 0) > 0) {
      query = query.in('status', input.triggerConfig.reservation_statuses!);
    }
    if (input.cursor) query = query.gt('id', input.cursor);
    const { data: reservations, error } = await query;
    if (error)
      throw new PmsScheduleBackfillError('Reservation batch lookup failed.');
    if (!reservations || reservations.length === 0) return [];

    const batchPropertyIds = [
      ...new Set(reservations.map((row) => row.pms_property_id as string)),
    ];
    const { data: properties, error: propertyError } = await this.db
      .from('pms_properties')
      .select('id, account_id, timezone')
      .eq('account_id', input.accountId)
      .in('id', batchPropertyIds);
    if (propertyError)
      throw new PmsScheduleBackfillError('Property timezone lookup failed.');
    const timezones = new Map(
      (properties ?? []).map((property) => [
        property.id as string,
        property.timezone as string | null,
      ])
    );

    return reservations.map((reservation) => ({
      reservation_id: reservation.id as string,
      account_id: reservation.account_id as string,
      property_id: reservation.pms_property_id as string,
      property_timezone:
        timezones.get(reservation.pms_property_id as string) ?? null,
      reservation_status: reservation.status as string,
      channel: reservation.channel_code as string | null,
      check_in: reservation.check_in as string | null,
      check_out: reservation.check_out as string | null,
      reservation_updated_at: reservation.updated_at as string,
    }));
  }

  async upsertScheduledJobs(
    jobs: AutomationTriggerJobInsert[]
  ): Promise<number> {
    if (jobs.length === 0) return 0;
    const { data, error } = await this.db.rpc(
      'upsert_pms_automation_schedule_jobs',
      { p_jobs: jobs }
    );
    if (error)
      throw new PmsScheduleBackfillError(
        'Scheduled occurrence batch upsert failed.'
      );
    return parsePmsScheduleUpsertResult(data, jobs.length).affected;
  }

  async cancelFutureJobsForAutomation(input: {
    automationId: string;
    accountId: string;
    now: string;
    reason: string;
  }): Promise<number> {
    const { data, error } = await this.db
      .from('automation_trigger_jobs')
      .update({
        status: 'cancelled',
        processing_started_at: null,
        retryable: false,
        next_attempt_at: null,
        last_error: input.reason,
        completed_at: input.now,
      })
      .eq('automation_id', input.automationId)
      .eq('account_id', input.accountId)
      .in('trigger_type', ['before_checkin', 'checkin_day', 'after_checkout'])
      .in('status', ['scheduled', 'failed'])
      .gt('run_at', input.now)
      .select('id');
    if (error)
      throw new PmsScheduleBackfillError(
        'Future automation schedule cancellation failed.'
      );
    return data?.length ?? 0;
  }
}
