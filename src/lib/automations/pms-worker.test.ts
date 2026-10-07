import { describe, expect, it, vi } from 'vitest';

import type { Automation } from '@/types';
import type { ReservationAutomationContext } from './pms-context';
import {
  processPmsAutomationJob,
  type AutomationTriggerJobClaim,
  type PmsAutomationJobStore,
} from './pms-worker';

const reservation: ReservationAutomationContext = {
  reservation_id: 'r1',
  external_reservation_id: 'e1',
  reservation_reference: 'R1',
  account_id: 'a1',
  contact_id: 'c1',
  guest_name: 'Guest',
  property_id: 'p1',
  property_name: 'Villa',
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
  pms_integration_id: 'i1',
  provider: 'pms',
  reservation_updated_at: '2026-09-28T11:00:00.000Z',
};
const job: AutomationTriggerJobClaim = {
  id: 'j1',
  accountId: 'a1',
  automationId: 'auto1',
  reservationId: 'r1',
  webhookEventId: 'event1',
  triggerType: 'reservation_confirmed',
  runAt: '2026-09-28T00:00:00.000Z',
  processingStartedAt: '2026-09-28T00:00:00.000Z',
  attemptCount: 1,
};
const active: Automation = {
  id: 'auto1',
  account_id: 'a1',
  user_id: 'u1',
  name: 'Welcome',
  trigger_type: 'reservation_confirmed',
  trigger_config: {},
  is_active: true,
  execution_count: 0,
  created_at: '',
  updated_at: '',
};

class MemoryStore implements PmsAutomationJobStore {
  automation: Automation | null = active;
  result: string | null = null;
  failures: unknown[] = [];
  completedExecution = false;
  markCompletedCalls = 0;
  failMarkCompletedOnce = false;
  async claimJobs() {
    return [job];
  }
  async findCompletedExecution() {
    return this.completedExecution ? { logId: 'log1' } : null;
  }
  async loadAutomation() {
    return this.automation;
  }
  async markCompleted() {
    this.markCompletedCalls += 1;
    if (this.failMarkCompletedOnce) {
      this.failMarkCompletedOnce = false;
      throw new Error('database connection lost after automation completion');
    }
    this.result = 'completed';
  }
  async markSuppressed(
    _job: AutomationTriggerJobClaim,
    _date: string,
    reason: string
  ) {
    this.result = `suppressed:${reason}`;
  }
  async markRescheduled() {
    this.result = 'rescheduled';
  }
  async markFailed(_job: AutomationTriggerJobClaim, input: { error: string }) {
    this.result = `failed:${input.error}`;
    this.failures.push(input);
  }
}

describe('PMS automation job worker', () => {
  it('rechecks the canonical reservation and dispatches the existing engine', async () => {
    const store = new MemoryStore();
    const dispatch = vi.fn().mockResolvedValue({
      logId: 'log1',
      status: 'success',
      errorMessage: null,
      disposition: 'executed',
    });
    const result = await processPmsAutomationJob(job, {
      store,
      loadContext: async () => reservation,
      dispatch,
    });
    expect(result).toBe('completed');
    expect(dispatch).toHaveBeenCalledWith(
      'auto1',
      expect.objectContaining({ contactId: 'c1' }),
      {
        triggerJobId: 'j1',
        attemptCount: 1,
        expectedReservationUpdatedAt: '2026-09-28T11:00:00.000Z',
      }
    );
    expect(store.result).toBe('completed');
  });

  it.each([
    'cancellation',
    'check-in date update',
    'other canonical metadata update',
  ])(
    'suppresses without retry when the final gate detects a %s race',
    async () => {
      const store = new MemoryStore();
      const dispatch = vi.fn().mockResolvedValue({
        logId: null,
        status: 'suppressed',
        errorMessage: null,
        disposition: 'reservation_changed',
      });

      expect(
        await processPmsAutomationJob(job, {
          store,
          // This is the version/context the worker validated. The mocked gate
          // represents the canonical row changing immediately afterwards.
          loadContext: async () => reservation,
          dispatch,
        })
      ).toBe('suppressed');

      expect(store.result).toBe(
        'suppressed:Reservation changed after eligibility validation.'
      );
      expect(store.failures).toHaveLength(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
    }
  );

  it('suppresses inactive automations and cancelled non-cancellation jobs', async () => {
    const inactive = new MemoryStore();
    inactive.automation = { ...active, is_active: false };
    expect(
      await processPmsAutomationJob(job, {
        store: inactive,
        loadContext: async () => reservation,
      })
    ).toBe('suppressed');
    expect(inactive.result).toContain('suppressed:');

    const cancelled = new MemoryStore();
    expect(
      await processPmsAutomationJob(job, {
        store: cancelled,
        loadContext: async () => ({
          ...reservation,
          reservation_status: 'cancelled',
        }),
      })
    ).toBe('suppressed');
  });

  it('suppresses a claimed job when the engine re-read observes deactivation', async () => {
    const store = new MemoryStore();
    const dispatch = vi.fn().mockResolvedValue({
      logId: null,
      status: 'suppressed',
      errorMessage: null,
      disposition: 'ineligible',
    });
    expect(
      await processPmsAutomationJob(job, {
        store,
        loadContext: async () => reservation,
        dispatch,
      })
    ).toBe('suppressed');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(store.result).toContain('suppressed:');
  });

  it('records retryable execution failures and terminal relationship failures', async () => {
    const retry = new MemoryStore();
    const dispatch = vi.fn().mockResolvedValue({
      logId: 'log1',
      status: 'failed',
      errorMessage: 'Meta temporary failure',
      disposition: 'executed',
    });
    expect(
      await processPmsAutomationJob(job, {
        store: retry,
        loadContext: async () => reservation,
        dispatch,
      })
    ).toBe('failed');
    expect(retry.result).toContain('failed:Meta temporary failure');
    expect((retry.failures[0] as { retryable: boolean }).retryable).toBe(true);

    const terminal = new MemoryStore();
    expect(
      await processPmsAutomationJob(job, {
        store: terminal,
        loadContext: async () => null,
      })
    ).toBe('failed');
    expect((terminal.failures[0] as { retryable: boolean }).retryable).toBe(
      false
    );
  });

  it('finalizes a duplicate or stale invocation from its successful durable execution', async () => {
    const store = new MemoryStore();
    store.completedExecution = true;
    const dispatch = vi.fn();

    expect(
      await processPmsAutomationJob(
        { ...job, attemptCount: 2 },
        { store, loadContext: async () => reservation, dispatch }
      )
    ).toBe('completed');
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.markCompletedCalls).toBe(1);
  });

  it('recovers a crash between automation completion and job completion without redispatch', async () => {
    const store = new MemoryStore();
    store.failMarkCompletedOnce = true;
    const dispatch = vi.fn().mockImplementation(async () => {
      store.completedExecution = true;
      return {
        logId: 'log1',
        status: 'success',
        errorMessage: null,
        disposition: 'executed',
      };
    });

    expect(
      await processPmsAutomationJob(job, {
        store,
        loadContext: async () => reservation,
        dispatch,
      })
    ).toBe('failed');
    expect(dispatch).toHaveBeenCalledTimes(1);

    expect(
      await processPmsAutomationJob(
        { ...job, attemptCount: 2 },
        { store, loadContext: async () => reservation, dispatch }
      )
    ).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('retries a failed automation but cannot create a second successful execution', async () => {
    const store = new MemoryStore();
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({
        logId: 'log1',
        status: 'failed',
        errorMessage: 'temporary',
        disposition: 'executed',
      })
      .mockImplementationOnce(async () => {
        store.completedExecution = true;
        return {
          logId: 'log1',
          status: 'success',
          errorMessage: null,
          disposition: 'executed',
        };
      });

    expect(
      await processPmsAutomationJob(job, {
        store,
        loadContext: async () => reservation,
        dispatch,
      })
    ).toBe('failed');
    expect(
      await processPmsAutomationJob(
        { ...job, attemptCount: 2 },
        { store, loadContext: async () => reservation, dispatch }
      )
    ).toBe('completed');
    expect(
      await processPmsAutomationJob(
        { ...job, attemptCount: 3 },
        { store, loadContext: async () => reservation, dispatch }
      )
    ).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('leaves a duplicate current invocation alone while its execution is running', async () => {
    const store = new MemoryStore();
    const dispatch = vi.fn().mockResolvedValue({
      logId: 'log1',
      status: 'processing',
      errorMessage: null,
      disposition: 'already_running',
    });
    expect(
      await processPmsAutomationJob(job, {
        store,
        loadContext: async () => reservation,
        dispatch,
      })
    ).toBe('inProgress');
    expect(store.result).toBeNull();
  });
});

describe('semantic preparation job retry classification', () => {
  it.each([false, true])(
    'uses execution retryability %s',
    async (retryable) => {
      const store = new MemoryStore();
      await processPmsAutomationJob(job, {
        store,
        loadContext: async () => reservation,
        dispatch: async () => ({
          logId: 'log1',
          status: 'failed',
          errorMessage: 'runtime_provider_failure',
          disposition: 'executed',
          retryable,
        }),
      });
      expect(store.failures[0]).toMatchObject({ retryable });
      expect(store.markCompletedCalls).toBe(0);
    }
  );
});
