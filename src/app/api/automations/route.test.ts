import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compatibility: vi.fn(async () => [] as { path: string; message: string }[]),
  requireRole: vi.fn(),
  resolveConnection: vi.fn(),
  insertSteps: vi.fn(),
  backfill: vi.fn(),
  insertedAutomation: null as Record<string, unknown> | null,
  insertPayloads: [] as Record<string, unknown>[],
  updatePayloads: [] as Record<string, unknown>[],
  deleteError: null as Error | null,
  updateError: null as Error | null,
}));

vi.mock('@/lib/automations/validate-template-compatibility', () => ({
  validateAutomationTemplateCompatibility: mocks.compatibility,
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
  insertSteps: mocks.insertSteps,
}));

vi.mock('@/lib/automations/pms-schedule-backfill', () => ({
  backfillPmsAutomationSchedules: mocks.backfill,
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'automations')
        throw new Error(`unexpected table: ${table}`);
      let operation: 'insert' | 'update' | 'delete' | null = null;
      const builder = {
        insert: (payload: Record<string, unknown>) => {
          operation = 'insert';
          mocks.insertPayloads.push(payload);
          mocks.insertedAutomation = {
            ...(mocks.insertedAutomation ?? {}),
            ...payload,
          };
          return builder;
        },
        update: (payload: Record<string, unknown>) => {
          operation = 'update';
          mocks.updatePayloads.push(payload);
          if (!mocks.updateError && mocks.insertedAutomation) {
            Object.assign(mocks.insertedAutomation, payload);
          }
          return builder;
        },
        delete: () => {
          operation = 'delete';
          return builder;
        },
        eq: () => builder,
        select: () => builder,
        single: async () => ({
          data: mocks.insertedAutomation,
          error: operation === 'update' ? mocks.updateError : null,
        }),
        maybeSingle: async () => ({
          data: mocks.insertedAutomation,
          error: operation === 'update' ? mocks.updateError : null,
        }),
        then: (
          resolve: (value: { data: null; error: Error | null }) => unknown
        ) =>
          Promise.resolve({
            data: null,
            error: operation === 'delete' ? mocks.deleteError : null,
          }).then(resolve),
      };
      return builder;
    },
  }),
}));

import { POST } from './route';

const account = {
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  supabase: {},
};

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/automations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function addTagBody(triggerType: string) {
  return {
    name: 'CRM only',
    trigger_type: triggerType,
    trigger_config: {},
    is_active: true,
    steps: [{ step_type: 'add_tag', step_config: { tag_id: 'tag-1' } }],
  };
}

describe('POST /api/automations WhatsApp dependency', () => {
  beforeEach(() => {
    mocks.compatibility.mockReset().mockResolvedValue([]);
    mocks.requireRole.mockReset().mockResolvedValue(account);
    mocks.resolveConnection
      .mockReset()
      .mockResolvedValue({ id: 'connection-1' });
    mocks.insertSteps.mockReset().mockResolvedValue(null);
    mocks.backfill.mockReset().mockResolvedValue({
      scannedReservations: 0,
      scheduledJobs: 0,
    });
    mocks.insertedAutomation = { id: 'automation-1' };
    mocks.insertPayloads = [];
    mocks.updatePayloads = [];
    mocks.deleteError = null;
    mocks.updateError = null;
  });

  it.each(['new_contact_created', 'reservation_confirmed'])(
    'creates and activates a %s -> add_tag automation with zero connections',
    async (triggerType) => {
      const response = await POST(request(addTagBody(triggerType)));

      expect(response.status).toBe(201);
      expect(mocks.resolveConnection).not.toHaveBeenCalled();
      expect(mocks.insertPayloads[0]).toMatchObject({
        account_id: 'account-1',
        whatsapp_config_id: null,
        is_active: true,
      });
    }
  );

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
          const response = await POST(
            request({
              name: 'Test',
              trigger_type: 'new_contact_created',
              is_active,
              steps,
            })
          );
          expect(response.status).toBe(400);
          expect(mocks.insertPayloads).toEqual([]);
          expect(mocks.insertSteps).not.toHaveBeenCalled();
        }
      }
    }
  );

  it('rejects activation of a WhatsApp send automation with no connection', async () => {
    const response = await POST(
      request({
        name: 'Send welcome',
        trigger_type: 'new_contact_created',
        trigger_config: {},
        is_active: true,
        steps: [
          {
            step_type: 'send_template',
            step_config: {
              template_id: '11111111-1111-1111-1111-111111111111',
            },
          },
        ],
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.issues).toContainEqual(
      expect.objectContaining({
        path: 'whatsapp_config_id',
      })
    );
    expect(mocks.resolveConnection).not.toHaveBeenCalled();
    expect(mocks.insertPayloads).toHaveLength(0);
  });

  it('keeps send-template creation working with an owned connection', async () => {
    const response = await POST(
      request({
        name: 'Send welcome',
        trigger_type: 'new_contact_created',
        trigger_config: {},
        is_active: true,
        whatsapp_config_id: 'connection-1',
        steps: [
          {
            step_type: 'send_template',
            step_config: {
              template_id: '11111111-1111-1111-1111-111111111111',
            },
          },
        ],
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.resolveConnection).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'account-1',
      connectionId: 'connection-1',
    });
    expect(mocks.insertPayloads[0].whatsapp_config_id).toBe('connection-1');
  });

  it('creates an active CRM-trigger semantic send without any PMS database access', async () => {
    const steps = [
      {
        step_type: 'send_template',
        step_config: { template_id: '00000000-0000-4000-8000-000000000044' },
      },
    ];
    const response = await POST(
      request({
        name: 'Welcome contact',
        trigger_type: 'new_contact_created',
        trigger_config: {},
        is_active: true,
        whatsapp_config_id: 'connection-1',
        steps,
      })
    );
    expect(response.status).toBe(201);
    expect(mocks.insertSteps).toHaveBeenCalled();
    expect(mocks.insertPayloads[0]).toMatchObject({
      trigger_type: 'new_contact_created',
      is_active: true,
    });
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it('rejects a foreign-workspace connection', async () => {
    const { WhatsAppConnectionError } =
      await import('@/lib/whatsapp/connection-resolver');
    mocks.resolveConnection.mockRejectedValueOnce(
      new WhatsAppConnectionError(
        'not_found',
        'WhatsApp connection not found for this workspace',
        404
      )
    );

    const response = await POST(
      request({
        ...addTagBody('new_contact_created'),
        whatsapp_config_id: 'foreign-connection',
      })
    );

    expect(response.status).toBe(404);
    expect(mocks.insertPayloads).toHaveLength(0);
  });

  it('backfills a newly created active stay-timing automation', async () => {
    mocks.insertedAutomation = {
      id: 'automation-1',
      trigger_type: 'checkin_day',
    };
    const response = await POST(
      request({
        ...addTagBody('checkin_day'),
        trigger_config: {
          local_time: '11:00',
          timezone: 'Asia/Kolkata',
        },
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.insertPayloads[0].is_active).toBe(false);
    expect(mocks.backfill).toHaveBeenCalledWith('automation-1', {
      allowInactiveActivation: true,
    });
    expect(mocks.updatePayloads).toContainEqual({ is_active: true });
    expect(mocks.resolveConnection).not.toHaveBeenCalled();
  });

  it('fails closed when backfill and cleanup deletion fail', async () => {
    mocks.insertedAutomation = {
      id: 'automation-1',
      trigger_type: 'checkin_day',
    };
    mocks.backfill.mockRejectedValueOnce(new Error('batch failed'));
    mocks.deleteError = new Error('delete failed');

    const response = await POST(
      request({
        ...addTagBody('checkin_day'),
        trigger_config: {
          local_time: '11:00',
          timezone: 'Asia/Kolkata',
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.automation_paused).toBe(true);
    expect(mocks.insertedAutomation?.is_active).toBe(false);
    expect(mocks.updatePayloads).toContainEqual({ is_active: false });
  });
  it.each([false, true])(
    'create enforces compatibility before writes, active=%s',
    async (is_active) => {
      const issues = [
        {
          path: 'steps[0].template_id',
          message:
            'This template requires reservation context and cannot be used with this automation trigger.',
        },
      ];
      mocks.compatibility.mockResolvedValueOnce(issues);
      const steps = [
        {
          step_type: 'send_template',
          step_config: {
            template_id: '11111111-1111-1111-1111-111111111111',
            requires_reservation: false,
          },
        },
      ];
      const response = await POST(
        request({
          name: 'Incompatible',
          trigger_type: 'new_contact_created',
          steps,
          is_active,
        })
      );
      expect(response.status).toBe(400);
      expect((await response.json()).issues).toEqual(issues);
      expect(mocks.compatibility).toHaveBeenCalledWith(
        expect.anything(),
        account.accountId,
        'new_contact_created',
        steps
      );
      expect(mocks.insertPayloads).toEqual([]);
      expect(mocks.insertSteps).not.toHaveBeenCalled();
    }
  );
});
