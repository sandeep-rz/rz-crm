import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  Automation,
  PmsAutomationTriggerType,
  PmsTriggerConfig,
} from '@/types';
import { supabaseAdmin } from './admin-client';
import { loadReservationAutomationContext } from './pms-context';
import {
  PMS_EVENT_AUTOMATION_TRIGGERS,
  isValidIanaTimeZone,
  PMS_LOCAL_TIME_PATTERN,
  PMS_OFFSET_DAYS_MAX,
  PMS_OFFSET_DAYS_MIN,
  PMS_SCHEDULED_AUTOMATION_TRIGGERS,
} from './pms-trigger-schema';

export {
  PMS_EVENT_AUTOMATION_TRIGGERS,
  PMS_SCHEDULED_AUTOMATION_TRIGGERS,
} from './pms-trigger-schema';

const EVENT_TRIGGER_BY_PMS_EVENT = {
  'reservation.confirmed': 'reservation_confirmed',
  'reservation.updated': 'reservation_updated',
  'reservation.cancelled': 'reservation_cancelled',
} as const satisfies Record<string, PmsAutomationTriggerType>;

export interface PmsAutomationScheduleInput {
  accountId: string;
  reservationId: string;
  webhookEventId: string;
  eventType: keyof typeof EVENT_TRIGGER_BY_PMS_EVENT;
}

export interface PmsAutomationScheduleResult {
  eventJobs: number;
  scheduledJobs: number;
  cancelledJobs: number;
}

/** The canonical reservation fields shared by webhook scheduling and backfill. */
export interface ReservationSchedulingContext {
  reservation_id: string;
  account_id: string;
  property_id: string;
  property_timezone: string | null;
  reservation_status: string;
  channel: string | null;
  check_in: string | null;
  check_out: string | null;
  reservation_updated_at?: string | null;
}

export interface AutomationTriggerJobInsert {
  account_id: string;
  automation_id: string;
  pms_reservation_id: string;
  pms_webhook_event_id: string | null;
  trigger_type: PmsAutomationTriggerType;
  occurrence_key: string;
  run_at: string;
  source_updated_at?: string | null;
}

export interface PmsAutomationScheduleStore {
  loadActiveAutomations(accountId: string): Promise<Automation[]>;
  insertEventJob(job: AutomationTriggerJobInsert): Promise<boolean>;
  upsertScheduledJob(job: AutomationTriggerJobInsert): Promise<boolean>;
  cancelFutureJobs(
    reservationId: string,
    accountId: string,
    reason: string,
    sourceUpdatedAt?: string | null
  ): Promise<number>;
}

export class PmsAutomationScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmsAutomationScheduleError';
  }
}

export interface PmsScheduleUpsertResult {
  requested: number;
  affected: number;
  completed: number;
  stale: number;
}

export function parsePmsScheduleUpsertResult(
  value: unknown,
  expectedRequested: number
): PmsScheduleUpsertResult {
  const result = value as Partial<PmsScheduleUpsertResult> | null;
  if (
    !result ||
    result.requested !== expectedRequested ||
    !Number.isInteger(result.affected) ||
    !Number.isInteger(result.completed) ||
    !Number.isInteger(result.stale) ||
    (result.affected ?? -1) < 0 ||
    (result.completed ?? -1) < 0 ||
    (result.stale ?? -1) < 0 ||
    result.affected! + result.completed! + result.stale! !== expectedRequested
  ) {
    throw new PmsAutomationScheduleError(
      'Scheduled occurrence batch did not converge completely.'
    );
  }
  return result as PmsScheduleUpsertResult;
}

function listIncludes(values: unknown, candidate: string | null): boolean {
  if (!Array.isArray(values) || values.length === 0) return true;
  if (!candidate) return false;
  return values.some(
    (value) => String(value).toLowerCase() === candidate.toLowerCase()
  );
}

export function matchesReservationTriggerConfig(
  config: PmsTriggerConfig,
  reservation: ReservationSchedulingContext
): boolean {
  const propertyIds = Array.isArray(config.property_ids)
    ? config.property_ids
    : config.property_id
      ? [config.property_id]
      : [];
  return (
    listIncludes(propertyIds, reservation.property_id) &&
    listIncludes(config.channels, reservation.channel) &&
    listIncludes(config.reservation_statuses, reservation.reservation_status)
  );
}

export function isReservationEligibleForTiming(
  reservation: ReservationSchedulingContext
): boolean {
  return !['cancelled', 'canceled'].includes(
    reservation.reservation_status.toLowerCase()
  );
}

function formatParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** Convert an explicit property-local wall time to an instant without using server timezone. */
export function localDateTimeToUtc(
  localDate: string,
  localTime: string,
  timeZone: string
): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const timeMatch = PMS_LOCAL_TIME_PATTERN.exec(localTime);
  if (!dateMatch || !timeMatch || !isValidIanaTimeZone(timeZone)) return null;
  const target = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0
  );
  let instant = target;
  for (let i = 0; i < 3; i += 1) {
    const p = formatParts(new Date(instant), timeZone);
    const represented = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second)
    );
    instant -= represented - target;
  }
  const verified = formatParts(new Date(instant), timeZone);
  if (
    verified.year !== dateMatch[1] ||
    verified.month !== dateMatch[2] ||
    verified.day !== dateMatch[3] ||
    verified.hour !== timeMatch[1] ||
    verified.minute !== timeMatch[2]
  ) {
    return null;
  }
  return new Date(instant).toISOString();
}

function addDays(date: string, days: number): string | null {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return null;
  const instant = new Date(
    Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]))
  );
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

export function computeScheduledRunAt(
  triggerType: PmsAutomationTriggerType,
  config: PmsTriggerConfig,
  reservation: ReservationSchedulingContext
): string | null {
  // Existing saved definitions may carry an explicit timezone. Preserve that
  // behavior, while new definitions resolve the business timezone from the
  // reservation's canonical PMS property.
  const timezone = config.timezone ?? reservation.property_timezone;
  if (!timezone || !config.local_time) return null;
  let localDate: string | null = null;
  if (triggerType === 'before_checkin' && reservation.check_in) {
    const days = Number(config.days_before ?? 0);
    if (
      !Number.isInteger(days) ||
      days < PMS_OFFSET_DAYS_MIN ||
      days > PMS_OFFSET_DAYS_MAX
    )
      return null;
    localDate = addDays(reservation.check_in, -days);
  } else if (triggerType === 'checkin_day' && reservation.check_in) {
    localDate = reservation.check_in;
  } else if (triggerType === 'after_checkout' && reservation.check_out) {
    const days = Number(config.days_after ?? 0);
    if (
      !Number.isInteger(days) ||
      days < PMS_OFFSET_DAYS_MIN ||
      days > PMS_OFFSET_DAYS_MAX
    )
      return null;
    localDate = addDays(reservation.check_out, days);
  }
  return localDate
    ? localDateTimeToUtc(localDate, config.local_time, timezone)
    : null;
}

export function eventOccurrenceKey(input: {
  automationId: string;
  reservationId: string;
  webhookEventId: string;
  triggerType: PmsAutomationTriggerType;
}) {
  return `pms:event:${input.automationId}:${input.reservationId}:${input.webhookEventId}:${input.triggerType}`;
}

export function scheduledOccurrenceKey(input: {
  automationId: string;
  reservationId: string;
  triggerType: PmsAutomationTriggerType;
}) {
  return `pms:schedule:${input.automationId}:${input.reservationId}:${input.triggerType}`;
}

export async function schedulePmsAutomationsAfterSync(
  input: PmsAutomationScheduleInput,
  dependencies: {
    store?: PmsAutomationScheduleStore;
    loadContext?: typeof loadReservationAutomationContext;
    now?: () => Date;
  } = {}
): Promise<PmsAutomationScheduleResult> {
  const store = dependencies.store ?? new SupabasePmsAutomationScheduleStore();
  const loadContext =
    dependencies.loadContext ?? loadReservationAutomationContext;
  const now = dependencies.now ?? (() => new Date());
  const reservation = await loadContext(input.reservationId, input.accountId);
  if (!reservation || reservation.account_id !== input.accountId) {
    throw new PmsAutomationScheduleError(
      'Canonical reservation context is invalid.'
    );
  }

  const automations = await store.loadActiveAutomations(input.accountId);
  const eventTrigger = EVENT_TRIGGER_BY_PMS_EVENT[input.eventType];
  const result: PmsAutomationScheduleResult = {
    eventJobs: 0,
    scheduledJobs: 0,
    cancelledJobs: 0,
  };

  for (const automation of automations) {
    if (automation.trigger_type !== eventTrigger) continue;
    if (
      !matchesReservationTriggerConfig(
        automation.trigger_config as PmsTriggerConfig,
        reservation
      )
    )
      continue;
    const inserted = await store.insertEventJob({
      account_id: input.accountId,
      automation_id: automation.id,
      pms_reservation_id: reservation.reservation_id,
      pms_webhook_event_id: input.webhookEventId,
      trigger_type: eventTrigger,
      occurrence_key: eventOccurrenceKey({
        automationId: automation.id,
        reservationId: reservation.reservation_id,
        webhookEventId: input.webhookEventId,
        triggerType: eventTrigger,
      }),
      run_at: now().toISOString(),
      source_updated_at: reservation.reservation_updated_at ?? null,
    });
    if (inserted) result.eventJobs += 1;
  }

  if (input.eventType === 'reservation.cancelled') {
    result.cancelledJobs = await store.cancelFutureJobs(
      reservation.reservation_id,
      input.accountId,
      'Reservation cancelled.',
      reservation.reservation_updated_at
    );
    return result;
  }

  if (!isReservationEligibleForTiming(reservation)) {
    result.cancelledJobs = await store.cancelFutureJobs(
      reservation.reservation_id,
      input.accountId,
      'Reservation is not eligible for stay-timing automation.',
      reservation.reservation_updated_at
    );
    return result;
  }

  for (const automation of automations) {
    if (
      !PMS_SCHEDULED_AUTOMATION_TRIGGERS.includes(
        automation.trigger_type as (typeof PMS_SCHEDULED_AUTOMATION_TRIGGERS)[number]
      )
    )
      continue;
    if (
      !matchesReservationTriggerConfig(
        automation.trigger_config as PmsTriggerConfig,
        reservation
      )
    )
      continue;
    const scheduledTrigger =
      automation.trigger_type as PmsAutomationTriggerType;
    const runAt = computeScheduledRunAt(
      scheduledTrigger,
      automation.trigger_config as PmsTriggerConfig,
      reservation
    );
    if (!runAt || Date.parse(runAt) <= now().getTime()) continue;
    const inserted = await store.upsertScheduledJob({
      account_id: input.accountId,
      automation_id: automation.id,
      pms_reservation_id: reservation.reservation_id,
      pms_webhook_event_id: null,
      trigger_type: scheduledTrigger,
      occurrence_key: scheduledOccurrenceKey({
        automationId: automation.id,
        reservationId: reservation.reservation_id,
        triggerType: scheduledTrigger,
      }),
      run_at: runAt,
      source_updated_at: reservation.reservation_updated_at ?? null,
    });
    if (inserted) result.scheduledJobs += 1;
  }

  return result;
}

export class SupabasePmsAutomationScheduleStore implements PmsAutomationScheduleStore {
  constructor(private readonly db: SupabaseClient = supabaseAdmin()) {}

  async loadActiveAutomations(accountId: string): Promise<Automation[]> {
    const triggers = [
      ...PMS_EVENT_AUTOMATION_TRIGGERS,
      ...PMS_SCHEDULED_AUTOMATION_TRIGGERS,
    ];
    const { data, error } = await this.db
      .from('automations')
      .select('*')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', triggers);
    if (error)
      throw new PmsAutomationScheduleError('Automation lookup failed.');
    return (data ?? []) as Automation[];
  }

  async insertEventJob(job: AutomationTriggerJobInsert): Promise<boolean> {
    const { data, error } = await this.db
      .from('automation_trigger_jobs')
      .upsert(job, { onConflict: 'occurrence_key', ignoreDuplicates: true })
      .select('id');
    if (error)
      throw new PmsAutomationScheduleError('Event occurrence insert failed.');
    return (data?.length ?? 0) > 0;
  }

  async upsertScheduledJob(job: AutomationTriggerJobInsert): Promise<boolean> {
    const { data, error } = await this.db.rpc(
      'upsert_pms_automation_schedule_jobs',
      { p_jobs: [job] }
    );
    if (error)
      throw new PmsAutomationScheduleError(
        'Scheduled occurrence insert failed.'
      );
    return parsePmsScheduleUpsertResult(data, 1).affected === 1;
  }

  async cancelFutureJobs(
    reservationId: string,
    accountId: string,
    reason: string,
    sourceUpdatedAt?: string | null
  ): Promise<number> {
    const { data, error } = await this.db
      .from('automation_trigger_jobs')
      .update({
        status: 'cancelled',
        processing_started_at: null,
        retryable: false,
        next_attempt_at: null,
        last_error: reason,
        completed_at: new Date().toISOString(),
        ...(sourceUpdatedAt ? { source_updated_at: sourceUpdatedAt } : {}),
      })
      .eq('account_id', accountId)
      .eq('pms_reservation_id', reservationId)
      .in('trigger_type', PMS_SCHEDULED_AUTOMATION_TRIGGERS)
      .in('status', ['scheduled', 'failed'])
      .select('id');
    if (error)
      throw new PmsAutomationScheduleError(
        'Future occurrence cancellation failed.'
      );
    return data?.length ?? 0;
  }
}
