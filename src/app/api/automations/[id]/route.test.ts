import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveConnection: vi.fn(),
  loadStepsTree: vi.fn(),
  replaceSteps: vi.fn(),
  backfill: vi.fn(),
  cancelSchedules: vi.fn(),
  existing: null as Record<string, unknown> | null,
  updatePayloads: [] as Record<string, unknown>[],
  updateError: null as Error | null,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: vi.fn(),
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/whatsapp/connection-resolver', () => {
  class WhatsAppConnectionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number
    ) {
      super(message);
    }
  }
  return {
    WhatsAppConnectionError,
    resolveWhatsAppConnection: mocks.resolveConnection,
  };
});

vi.mock('@/lib/automations/steps-tree', () => ({
  loadStepsTree: mocks.loadStepsTree,
  replaceSteps: mocks.replaceSteps,
}));

vi.mock('@/lib/automations/pms-schedule-backfill', () => ({
  backfillPmsAutomationSchedules: mocks.backfill,
  cancelFuturePmsAutomationSchedules: mocks.cancelSchedules,
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'automations')
        throw new Error(`unexpected table: ${table}`);
      const builder: Record<string, unknown> = {};
      builder.select = vi.fn(() => builder);
      builder.update = vi.fn((payload: Record<string, unknown>) => {
        mocks.updatePayloads.push(payload);
        if (!mocks.updateError && mocks.existing) {
          Object.assign(mocks.existing, payload);
        }
        return builder;
      });
      builder.eq = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(async () => ({
        data: mocks.existing,
        error: mocks.updateError,
      }));
      builder.then = (
        resolve: (value: { data: null; error: Error | null }) => unknown
      ) =>
        Promise.resolve({ data: null, error: mocks.updateError }).then(resolve);
      return builder;
    },
  }),
}));

import { PATCH } from './route';

const account = {
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  supabase: {},
};
const params = { params: Promise.resolve({ id: 'automation-1' }) };

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/automations/automation-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/automations/[id] WhatsApp dependency', () => {
  beforeEach(() => {
    mocks.requireRole.mockReset().mockResolvedValue(account);
    mocks.resolveConnection
      .mockReset()
      .mockResolvedValue({ id: 'connection-1' });
    mocks.loadStepsTree
      .mockReset()
      .mockResolvedValue([
        { step_type: 'add_tag', step_config: { tag_id: 'tag-1' } },
      ]);
    mocks.replaceSteps.mockReset().mockResolvedValue(null);
    mocks.backfill.mockReset().mockResolvedValue({
      scannedReservations: 0,
      scheduledJobs: 0,
    });
    mocks.cancelSchedules.mockReset().mockResolvedValue(0);
    mocks.existing = {
      id: 'automation-1',
      user_id: 'user-1',
      account_id: 'account-1',
      whatsapp_config_id: 'connection-1',
      is_active: true,
      trigger_type: 'new_contact_created',
      trigger_config: {},
    };
    mocks.updatePayloads = [];
    mocks.updateError = null;
  });

  it.each([false, true])(
    'rejects invalid template actions before any write, active=%s',
    async (is_active) => {
      for (const step_config of [
        { template_name: 'old' },
        { template_id: '11111111-1111-1111-1111-111111111111', variables: {} },
        {
          template_id: '11111111-1111-1111-1111-111111111111',
          variable_mappings: [],
        },
      ]) {
        for (const nested of [false, true]) {
          const action = { step_type: 'send_template', step_config };
          const steps = nested
            ? [
                {
                  step_type: 'condition',
                  step_config: {},
                  branches: { yes: [], no: [action] },
                },
              ]
            : [action];
          const response = await PATCH(
            request({
              name: 'Test',
              trigger_type: 'new_contact_created',
              is_active,
              steps,
            }),
            params
          );
          expect(response.status).toBe(400);
          expect(mocks.updatePayloads).toEqual([]);
          expect(mocks.replaceSteps).not.toHaveBeenCalled();
        }
      }
    }
  );

  it('can explicitly remove whatsapp_config_id from an active CRM-only automation', async () => {
    const response = await PATCH(request({ whatsapp_config_id: null }), params);

    expect(response.status).toBe(200);
    expect(mocks.resolveConnection).not.toHaveBeenCalled();
    expect(mocks.updatePayloads).toContainEqual({ whatsapp_config_id: null });
  });

  it('does not allow a foreign-workspace connection', async () => {
    const { WhatsAppConnectionError } =
      await import('@/lib/whatsapp/connection-resolver');
    mocks.resolveConnection.mockRejectedValueOnce(
      new WhatsAppConnectionError(
        'not_found',
        'WhatsApp connection not found for this workspace',
        404
      )
    );

    const response = await PATCH(
      request({
        whatsapp_config_id: 'foreign-connection',
      }),
      params
    );

    expect(response.status).toBe(404);
    expect(mocks.updatePayloads).toHaveLength(0);
  });

  it('backfills on false to true stay-timing activation', async () => {
    mocks.existing = {
      ...mocks.existing,
      is_active: false,
      trigger_type: 'checkin_day',
      trigger_config: { local_time: '11:00', timezone: 'Asia/Kolkata' },
    };
    const response = await PATCH(request({ is_active: true }), params);

    expect(response.status).toBe(200);
    expect(mocks.backfill).toHaveBeenCalledWith('automation-1', {
      allowInactiveActivation: true,
    });
    expect(mocks.updatePayloads).toContainEqual({ is_active: false });
    expect(mocks.updatePayloads).toContainEqual({ is_active: true });
    expect(mocks.cancelSchedules).not.toHaveBeenCalled();
  });

  it('cancels future schedules on deactivation', async () => {
    mocks.existing = {
      ...mocks.existing,
      trigger_type: 'checkin_day',
      trigger_config: { local_time: '11:00', timezone: 'Asia/Kolkata' },
    };
    const response = await PATCH(request({ is_active: false }), params);

    expect(response.status).toBe(200);
    expect(mocks.cancelSchedules).toHaveBeenCalledOnce();
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it('replaces future schedules when active timing configuration changes', async () => {
    mocks.existing = {
      ...mocks.existing,
      trigger_type: 'before_checkin',
      trigger_config: {
        local_time: '18:00',
        days_before: 1,
        timezone: 'Asia/Kolkata',
      },
    };
    const response = await PATCH(
      request({
        trigger_config: {
          local_time: '15:00',
          days_before: 2,
          timezone: 'Asia/Kolkata',
        },
      }),
      params
    );

    expect(response.status).toBe(200);
    expect(mocks.cancelSchedules).toHaveBeenCalledOnce();
    expect(mocks.backfill).toHaveBeenCalledWith('automation-1', {
      allowInactiveActivation: true,
    });
    expect(mocks.updatePayloads).toContainEqual(
      expect.objectContaining({ is_active: false })
    );
    expect(mocks.updatePayloads).toContainEqual({ is_active: true });
  });

  it('does not reschedule an unrelated edit', async () => {
    mocks.existing = {
      ...mocks.existing,
      trigger_type: 'checkin_day',
      trigger_config: { local_time: '11:00', timezone: 'Asia/Kolkata' },
    };
    const response = await PATCH(request({ name: 'Renamed' }), params);

    expect(response.status).toBe(200);
    expect(mocks.cancelSchedules).not.toHaveBeenCalled();
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it('keeps a failed timing rebuild inactive and reports the pause', async () => {
    mocks.existing = {
      ...mocks.existing,
      trigger_type: 'before_checkin',
      trigger_config: {
        local_time: '18:00',
        days_before: 1,
        timezone: 'Asia/Kolkata',
      },
    };
    mocks.backfill.mockRejectedValueOnce(new Error('third batch failed'));
    const response = await PATCH(
      request({
        trigger_config: {
          local_time: '15:00',
          days_before: 2,
          timezone: 'Asia/Kolkata',
        },
      }),
      params
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe('pms_schedule_update_failed');
    expect(body.automation_paused).toBe(true);
    expect(mocks.existing?.is_active).toBe(false);
    expect(mocks.cancelSchedules).toHaveBeenCalledOnce();
  });

  it('refreshes as paused when step replacement fails during a staged rebuild', async () => {
    mocks.existing = {
      ...mocks.existing,
      trigger_type: 'checkin_day',
      trigger_config: { local_time: '11:00', timezone: 'Asia/Kolkata' },
    };
    mocks.replaceSteps.mockResolvedValueOnce('step write failed');
    const response = await PATCH(
      request({
        trigger_config: {
          local_time: '12:00',
          timezone: 'Asia/Kolkata',
        },
        steps: [{ step_type: 'add_tag', step_config: { tag_id: 'tag-1' } }],
      }),
      params
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.automation_paused).toBe(true);
    expect(mocks.existing?.is_active).toBe(false);
    expect(mocks.backfill).not.toHaveBeenCalled();
  });
});
