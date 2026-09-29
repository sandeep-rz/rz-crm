import { describe, expect, it } from 'vitest';

import type { Automation } from '@/types';
import type { ReservationAutomationContext } from './pms-context';
import {
  computeScheduledRunAt,
  schedulePmsAutomationsAfterSync,
  type AutomationTriggerJobInsert,
  type PmsAutomationScheduleStore,
} from './pms-scheduler';

const reservation: ReservationAutomationContext = {
  reservation_id: 'reservation-1',
  external_reservation_id: 'external-1',
  reservation_reference: 'RZ-1',
  account_id: 'account-1',
  contact_id: 'contact-1',
  guest_name: 'Guest One',
  property_id: 'property-1',
  property_name: 'Villa One',
  property_timezone: 'Asia/Kolkata',
  reservation_status: 'confirmed',
  provider_status: 'confirmed',
  channel: 'direct',
  channel_name: 'Direct',
  check_in: '2026-10-01',
  check_out: '2026-10-03',
  nights: 2,
  adults: 2,
  children: 0,
  occupancy_total: 2,
  total_amount: 100,
  currency: 'INR',
  pms_integration_id: 'integration-1',
  provider: 'rukiye_zara',
};

function automation(
  id: string,
  trigger_type: Automation['trigger_type'],
  config = {}
): Automation {
  return {
    id,
    account_id: 'account-1',
    user_id: 'user-1',
    name: id,
    trigger_type,
    trigger_config: config,
    is_active: true,
    execution_count: 0,
    created_at: '',
    updated_at: '',
  };
}

class MemoryStore implements PmsAutomationScheduleStore {
  automations: Automation[] = [];
  jobs = new Map<string, AutomationTriggerJobInsert>();
  cancelled = 0;
  async loadActiveAutomations() {
    return this.automations;
  }
  async insertEventJob(job: AutomationTriggerJobInsert) {
    if (this.jobs.has(job.occurrence_key)) return false;
    this.jobs.set(job.occurrence_key, job);
    return true;
  }
  async upsertScheduledJob(job: AutomationTriggerJobInsert) {
    const existed = this.jobs.has(job.occurrence_key);
    this.jobs.set(job.occurrence_key, job);
    return !existed;
  }
  async cancelFutureJobs() {
    this.cancelled += 1;
    return 1;
  }
}

describe('PMS automation scheduling adapter', () => {
  it('computes explicit property-local dates without server timezone assumptions', () => {
    expect(
      computeScheduledRunAt(
        'before_checkin',
        {
          timezone: 'Asia/Kolkata',
          local_time: '09:00',
          days_before: 1,
        },
        reservation
      )
    ).toBe('2026-09-30T03:30:00.000Z');
  });

  it('uses each reservation property timezone when the automation does not store one', () => {
    const config = { local_time: '10:00', days_before: 1 };
    expect(computeScheduledRunAt('before_checkin', config, reservation)).toBe(
      '2026-09-30T04:30:00.000Z'
    );
    expect(
      computeScheduledRunAt('before_checkin', config, {
        ...reservation,
        property_timezone: 'Asia/Dubai',
      })
    ).toBe('2026-09-30T06:00:00.000Z');
  });

  it('does not schedule with a missing property timezone', () => {
    expect(
      computeScheduledRunAt(
        'checkin_day',
        { local_time: '10:00' },
        {
          ...reservation,
          property_timezone: null,
        }
      )
    ).toBeNull();
  });

  it('creates one confirmed occurrence and is idempotent for duplicate event delivery', async () => {
    const store = new MemoryStore();
    store.automations = [automation('a1', 'reservation_confirmed')];
    const input = {
      accountId: 'account-1',
      reservationId: 'reservation-1',
      webhookEventId: 'event-1',
      eventType: 'reservation.confirmed' as const,
    };
    const loadContext = async () => reservation;
    expect(
      (await schedulePmsAutomationsAfterSync(input, { store, loadContext }))
        .eventJobs
    ).toBe(1);
    expect(
      (await schedulePmsAutomationsAfterSync(input, { store, loadContext }))
        .eventJobs
    ).toBe(0);
    expect(store.jobs.size).toBe(1);
  });

  it('fires reservation.updated only for explicit update automations', async () => {
    const store = new MemoryStore();
    store.automations = [
      automation('confirmed', 'reservation_confirmed'),
      automation('updated', 'reservation_updated'),
    ];
    await schedulePmsAutomationsAfterSync(
      {
        accountId: 'account-1',
        reservationId: 'reservation-1',
        webhookEventId: 'event-2',
        eventType: 'reservation.updated',
      },
      { store, loadContext: async () => reservation }
    );
    expect([...store.jobs.values()].map((job) => job.automation_id)).toEqual([
      'updated',
    ]);
  });

  it('upserts future timing jobs and cancels them on cancellation', async () => {
    const store = new MemoryStore();
    store.automations = [
      automation('before', 'before_checkin', {
        timezone: 'Asia/Kolkata',
        local_time: '09:00',
        days_before: 1,
      }),
    ];
    const base = {
      accountId: 'account-1',
      reservationId: 'reservation-1',
      webhookEventId: 'event-3',
    };
    await schedulePmsAutomationsAfterSync(
      { ...base, eventType: 'reservation.confirmed' },
      {
        store,
        loadContext: async () => reservation,
        now: () => new Date('2026-09-28T00:00:00.000Z'),
      }
    );
    expect(
      [...store.jobs.values()].some(
        (job) => job.trigger_type === 'before_checkin'
      )
    ).toBe(true);
    await schedulePmsAutomationsAfterSync(
      {
        ...base,
        webhookEventId: 'event-4',
        eventType: 'reservation.cancelled',
      },
      {
        store,
        loadContext: async () => ({
          ...reservation,
          reservation_status: 'cancelled',
        }),
      }
    );
    expect(store.cancelled).toBe(1);
    expect(
      [...store.jobs.values()].some(
        (job) => job.trigger_type === 'reservation_cancelled'
      )
    ).toBe(false);
  });
});
