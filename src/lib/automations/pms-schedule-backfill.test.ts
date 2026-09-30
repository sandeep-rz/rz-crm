import { describe, expect, it } from 'vitest';

import type { Automation } from '@/types';
import {
  backfillPmsAutomationSchedules,
  cancelFuturePmsAutomationSchedules,
  earliestRelevantDate,
  type PmsScheduleBackfillStore,
} from './pms-schedule-backfill';
import type {
  AutomationTriggerJobInsert,
  ReservationSchedulingContext,
} from './pms-scheduler';

const now = () => new Date('2026-09-29T06:30:00.000Z');

function automation(
  triggerType: Automation['trigger_type'],
  triggerConfig: Record<string, unknown>,
  active = true
): Automation {
  return {
    id: 'automation-1',
    account_id: 'account-1',
    user_id: 'user-1',
    name: 'Stay timing',
    trigger_type: triggerType,
    trigger_config: triggerConfig,
    is_active: active,
    execution_count: 0,
    created_at: '',
    updated_at: '',
  };
}

function reservation(
  overrides: Partial<ReservationSchedulingContext> = {}
): ReservationSchedulingContext {
  return {
    reservation_id: 'reservation-1',
    account_id: 'account-1',
    property_id: 'property-1',
    property_timezone: 'Asia/Kolkata',
    reservation_status: 'confirmed',
    channel: 'direct',
    check_in: '2026-09-30',
    check_out: '2026-10-02',
    reservation_updated_at: '2026-09-28T11:00:00.000Z',
    ...overrides,
  };
}

class MemoryStore implements PmsScheduleBackfillStore {
  automation: Automation | null = null;
  reservations: ReservationSchedulingContext[] = [];
  jobs = new Map<string, AutomationTriggerJobInsert>();
  batches = 0;
  cancelled = 0;
  completedKeys = new Set<string>();

  async loadAutomation() {
    return this.automation;
  }

  async loadReservationBatch(input: { cursor: string | null; limit: number }) {
    this.batches += 1;
    const start = input.cursor
      ? this.reservations.findIndex(
          (item) => item.reservation_id === input.cursor
        ) + 1
      : 0;
    return this.reservations.slice(start, start + input.limit);
  }

  async upsertScheduledJobs(jobs: AutomationTriggerJobInsert[]) {
    let inserted = 0;
    for (const job of jobs) {
      if (this.completedKeys.has(job.occurrence_key)) continue;
      const previous = this.jobs.get(job.occurrence_key);
      if (
        previous?.source_updated_at &&
        job.source_updated_at &&
        previous.source_updated_at > job.source_updated_at
      ) {
        continue;
      }
      const existed = this.jobs.has(job.occurrence_key);
      this.jobs.set(job.occurrence_key, job);
      if (!existed) inserted += 1;
    }
    return inserted;
  }

  async cancelFutureJobsForAutomation() {
    this.cancelled += 1;
    return 1;
  }
}

async function run(
  triggerType: Automation['trigger_type'],
  triggerConfig: Record<string, unknown>,
  reservations: ReservationSchedulingContext[],
  active = true
) {
  const store = new MemoryStore();
  store.automation = automation(triggerType, triggerConfig, active);
  store.reservations = reservations;
  const result = await backfillPmsAutomationSchedules('automation-1', {
    store,
    now,
    batchSize: 2,
  });
  return { store, result };
}

describe('PMS stay-timing activation backfill', () => {
  it('backfills a future check-in-day occurrence', async () => {
    const { store, result } = await run(
      'checkin_day',
      { local_time: '11:00' },
      [reservation()]
    );
    expect(result.scheduledJobs).toBe(1);
    expect([...store.jobs.values()][0]?.run_at).toBe(
      '2026-09-30T05:30:00.000Z'
    );
  });

  it('backfills before-check-in and after-checkout occurrences', async () => {
    const before = await run(
      'before_checkin',
      { local_time: '18:00', days_before: 1 },
      [reservation({ check_in: '2026-10-01' })]
    );
    expect([...before.store.jobs.values()][0]?.run_at).toBe(
      '2026-09-30T12:30:00.000Z'
    );

    const after = await run(
      'after_checkout',
      { local_time: '11:00', days_after: 2 },
      [reservation({ check_out: '2026-09-28' })]
    );
    expect([...after.store.jobs.values()][0]?.run_at).toBe(
      '2026-09-30T05:30:00.000Z'
    );
  });

  it('skips a missed occurrence instead of executing it', async () => {
    const { result } = await run('checkin_day', { local_time: '11:00' }, [
      reservation({ check_in: '2026-09-29' }),
    ]);
    expect(result.scheduledJobs).toBe(0);
  });

  it('respects status, cancellation, property, and channel filters', async () => {
    const { result } = await run(
      'checkin_day',
      {
        local_time: '18:00',
        property_ids: ['property-1'],
        channels: ['direct'],
        reservation_statuses: ['confirmed'],
      },
      [
        reservation({
          reservation_id: 'cancelled',
          reservation_status: 'cancelled',
        }),
        reservation({
          reservation_id: 'wrong-property',
          property_id: 'property-2',
        }),
        reservation({
          reservation_id: 'wrong-channel',
          channel: 'booking_com',
        }),
        reservation({
          reservation_id: 'wrong-status',
          reservation_status: 'pending',
        }),
      ]
    );
    expect(result.scheduledJobs).toBe(0);
  });

  it('does nothing for inactive or historical event automations', async () => {
    const inactive = await run(
      'checkin_day',
      { local_time: '18:00' },
      [reservation()],
      false
    );
    expect(inactive.store.batches).toBe(0);

    for (const trigger of [
      'reservation_confirmed',
      'reservation_updated',
      'reservation_cancelled',
    ] as const) {
      const event = await run(trigger, {}, [reservation()]);
      expect(event.store.batches).toBe(0);
      expect(event.result.scheduledJobs).toBe(0);
    }
  });

  it('allows a controlled inactive activation backfill without changing the default guard', async () => {
    const store = new MemoryStore();
    store.automation = automation(
      'checkin_day',
      { local_time: '18:00' },
      false
    );
    store.reservations = [reservation()];
    expect(
      (
        await backfillPmsAutomationSchedules('automation-1', {
          store,
          now,
          allowInactiveActivation: true,
        })
      ).scheduledJobs
    ).toBe(1);
  });

  it('is idempotent when run twice and batches reservations', async () => {
    const store = new MemoryStore();
    store.automation = automation('checkin_day', { local_time: '18:00' });
    store.reservations = [
      reservation({ reservation_id: 'reservation-1' }),
      reservation({ reservation_id: 'reservation-2' }),
      reservation({ reservation_id: 'reservation-3' }),
    ];
    const options = { store, now, batchSize: 1 };
    expect(
      (await backfillPmsAutomationSchedules('automation-1', options))
        .scheduledJobs
    ).toBe(3);
    expect(
      (await backfillPmsAutomationSchedules('automation-1', options))
        .scheduledJobs
    ).toBe(0);
    expect(store.jobs.size).toBe(3);
    expect(store.batches).toBeGreaterThan(2);
  });

  it('uses each property timezone for all-properties automations', async () => {
    const { store } = await run('checkin_day', { local_time: '18:00' }, [
      reservation({
        reservation_id: 'india',
        property_timezone: 'Asia/Kolkata',
      }),
      reservation({
        reservation_id: 'dubai',
        property_id: 'property-2',
        property_timezone: 'Asia/Dubai',
      }),
    ]);
    expect([...store.jobs.values()].map((job) => job.run_at).sort()).toEqual([
      '2026-09-30T12:30:00.000Z',
      '2026-09-30T14:00:00.000Z',
    ]);
  });

  it('keeps a newer webhook reservation schedule when stale backfill retries', async () => {
    const store = new MemoryStore();
    store.automation = automation('checkin_day', { local_time: '18:00' });
    store.reservations = [
      reservation({
        check_in: '2026-10-10',
        reservation_updated_at: '2026-09-28T10:00:00.000Z',
      }),
    ];
    await backfillPmsAutomationSchedules('automation-1', { store, now });
    const key = [...store.jobs.keys()][0]!;
    await store.upsertScheduledJobs([
      {
        ...store.jobs.get(key)!,
        run_at: '2026-10-12T12:30:00.000Z',
        source_updated_at: '2026-09-29T10:00:00.000Z',
      },
    ]);
    await backfillPmsAutomationSchedules('automation-1', { store, now });
    expect(store.jobs.get(key)?.run_at).toBe('2026-10-12T12:30:00.000Z');
  });

  it('never reopens an already completed logical occurrence', async () => {
    const store = new MemoryStore();
    store.automation = automation('checkin_day', { local_time: '18:00' });
    store.reservations = [reservation()];
    await backfillPmsAutomationSchedules('automation-1', { store, now });
    const key = [...store.jobs.keys()][0]!;
    const completedRunAt = store.jobs.get(key)!.run_at;
    store.completedKeys.add(key);
    store.automation = automation('checkin_day', { local_time: '20:00' });
    await backfillPmsAutomationSchedules('automation-1', { store, now });
    expect(store.jobs.get(key)?.run_at).toBe(completedRunAt);
    expect(store.jobs.size).toBe(1);
  });

  it('pads the UTC coarse boundary so property-local future dates are not excluded', () => {
    const instant = new Date('2026-09-29T23:30:00.000Z');
    expect(earliestRelevantDate('checkin_day', {}, instant)).toBe('2026-09-28');
    expect(
      earliestRelevantDate('before_checkin', { days_before: 2 }, instant)
    ).toBe('2026-09-30');
    expect(
      earliestRelevantDate('after_checkout', { days_after: 2 }, instant)
    ).toBe('2026-09-26');
  });

  it('suppresses future jobs through the existing queue state', async () => {
    const store = new MemoryStore();
    expect(
      await cancelFuturePmsAutomationSchedules(
        {
          automationId: 'automation-1',
          accountId: 'account-1',
          reason: 'Automation deactivated.',
        },
        { store, now }
      )
    ).toBe(1);
    expect(store.cancelled).toBe(1);
  });
});
