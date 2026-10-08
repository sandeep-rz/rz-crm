import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validateAutomationTemplateCompatibility } from './validate-template-compatibility';
import { PMS_AUTOMATION_TRIGGERS } from './pms-trigger-schema';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'account', userId: 'author' }),
  toErrorResponse: vi.fn(),
}));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => db }));
let storedSteps: Record<string, unknown>[];
let sourceTrigger = 'reservation_confirmed';
const templateId = '11111111-1111-4111-8111-111111111111';
const action = (extra = {}) => ({
  step_type: 'send_template',
  step_config: { template_id: templateId, ...extra },
});
let template: Record<string, unknown>;
let catalog: Record<string, unknown>[];
let failedTable: string | null;
let reads: { table: string; filters: [string, unknown][] }[];
function configure(
  key: string,
  scope = key.split('.')[0],
  source = scope === 'contact' || scope === 'workspace' ? 'crm' : 'provider'
) {
  template.semantic_variable_mapping = [
    { component: 'BODY', position: 1, variable_key: key },
  ];
  template.semantic_content = {
    body_text: `Hello {{${key}}}`,
    button_urls: {},
  };
  catalog = [
    {
      variable_key: key,
      source_scope: scope,
      resolution_source: source,
      is_active: true,
    },
  ];
}
const db = {
  from(table: string) {
    const filters: [string, unknown][] = [];
    reads.push({ table, filters });
    const q = {
      maybeSingle: async () => ({
        data: {
          id: 'automation',
          account_id: 'account',
          trigger_type: sourceTrigger,
          is_active: false,
        },
        error: null,
      }),
      insert: () => {
        throw new Error('Invalid automation reached INSERT');
      },
      update: () => {
        throw new Error('Invalid automation reached UPDATE');
      },
      select: () => q,
      in: () => q,
      order: () => q,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return q;
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === 'message_templates'
              ? [template].filter((row) =>
                  filters.every(([key, value]) => row[key] === value)
                )
              : table === 'automation_steps'
                ? storedSteps
                : catalog.filter((row) =>
                    filters.every(([key, value]) => row[key] === value)
                  ),
          error: table === failedTable ? { message: 'private failure' } : null,
        }).then(resolve),
    };
    return q;
  },
} as unknown as SupabaseClient;
const validate = (trigger = 'new_contact_created', steps = [action()]) =>
  validateAutomationTemplateCompatibility(db, 'account', trigger, steps);
beforeEach(() => {
  template = {
    id: templateId,
    account_id: 'account',
    whatsapp_config_id: 'connection',
    status: 'APPROVED',
    meta_template_id: 'meta-id',
    language: 'en_US',
    template_origin: 'rgcrm',
    variable_configuration_status: 'configured',
    body_text: 'Hello {{1}}',
    buttons: [],
  };
  configure('contact.first_name');
  reads = [];
  failedTable = null;
  sourceTrigger = 'reservation_confirmed';
  storedSteps = [
    {
      id: 'nested-action',
      parent_step_id: null,
      branch: null,
      position: 0,
      ...action(),
    },
  ];
});
it.each(['new_contact_created', 'tag_added', ...PMS_AUTOMATION_TRIGGERS])(
  'allows CRM-only template with %s',
  async (trigger) => {
    expect(await validate(trigger)).toEqual([]);
  }
);
it.each(PMS_AUTOMATION_TRIGGERS)(
  'allows a reservation template with %s',
  async (trigger) => {
    configure('reservation.check_in_date');
    expect(await validate(trigger)).toEqual([]);
  }
);
it.each([
  'new_message_received',
  'first_inbound_message',
  'keyword_match',
  'new_contact_created',
  'conversation_assigned',
  'tag_added',
  'time_based',
  'interactive_reply',
])('rejects reservation requirements with %s', async (trigger) => {
  configure('reservation.check_in_date');
  expect(await validate(trigger)).toEqual([
    {
      path: 'steps[0].template_id',
      message:
        'This template requires reservation context and cannot be used with this automation trigger.',
    },
  ]);
});
it.each(['property.name', 'listing.name', 'host.name'])(
  'rejects %s with non-reservation trigger using catalog ownership',
  async (key) => {
    configure(key);
    expect(await validate('tag_added')).toHaveLength(1);
  }
);
it('uses metadata rather than key prefixes and accepts workspace CRM ownership', async () => {
  configure('workspace.name');
  expect(await validate()).toEqual([]);
  configure('contact.provider_name', 'contact', 'provider');
  expect(await validate()).toHaveLength(1);
  configure('property.crm_name', 'contact', 'crm');
  expect(await validate()).toEqual([]);
});
it('does not trust client template names, mappings, or compatibility flags', async () => {
  configure('listing.name');
  expect(
    await validate('new_contact_created', [
      action({
        template_name: 'crm_only',
        requires_reservation: false,
        semantic_variable_mapping: [],
      }),
    ])
  ).toHaveLength(1);
});
it('validates nested actions and reports their existing issue path', async () => {
  configure('listing.name');
  const steps = [
    { step_type: 'condition', step_config: {}, branches: { no: [action()] } },
  ];
  expect(
    await validateAutomationTemplateCompatibility(
      db,
      'account',
      'tag_added',
      steps
    )
  ).toEqual([
    expect.objectContaining({ path: 'steps[0].no.steps[0].template_id' }),
  ]);
});
it.each(['needs_mapping', 'unconfigured'])(
  'rejects %s templates using existing usability rules',
  async (state) => {
    template.variable_configuration_status = state;
    expect(await validate()).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('configured semantic'),
      }),
    ]);
  }
);
it('rejects a mapping inconsistent with authoritative semantic content', async () => {
  template.semantic_variable_mapping = [];
  expect(await validate()).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('invalid semantic'),
    }),
  ]);
});
it.each(['new_contact_created', 'reservation_confirmed'])(
  'rejects missing and inactive canonical variables for %s',
  async (trigger) => {
    for (const inactive of [false, true]) {
      configure('contact.unknown_variable');
      if (inactive) catalog[0].is_active = false;
      else catalog = [];
      expect(await validate(trigger)).toEqual([
        {
          path: 'steps[0].template_id',
          message:
            'Selected template contains an unavailable semantic variable.',
        },
      ]);
    }
  }
);
it('reads templates only from the authorized workspace', async () => {
  template.account_id = 'foreign';
  expect(await validate()).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('unavailable'),
    }),
  ]);
  expect(reads[0].filters).toContainEqual(['account_id', 'account']);
});
it.each(['message_templates', 'message_variable_catalog'])(
  'fails closed on %s lookup failure',
  async (table) => {
    failedTable = table;
    expect(await validate()).toEqual([
      {
        path: 'steps',
        message: 'Template compatibility could not be verified. Try again.',
      },
    ]);
  }
);
it('does no template/catalog work for existing non-template automations', async () => {
  expect(
    await validate('new_contact_created', [
      { step_type: 'add_tag', step_config: { template_id: templateId } },
    ])
  ).toEqual([]);
  expect(reads).toEqual([]);
});

it.each(['create', 'update', 'duplicate'] as const)(
  'real %s route cannot bypass shared persisted-template validation',
  async (writePath) => {
    configure('listing.name');
    const params = { params: Promise.resolve({ id: 'automation' }) };
    let response: Response;
    if (writePath === 'create') {
      const { POST } = await import('@/app/api/automations/route');
      response = await POST(
        new Request('http://localhost/api/automations', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Invalid',
            trigger_type: 'tag_added',
            is_active: false,
            steps: [action({ requires_reservation: false })],
          }),
        })
      );
    } else if (writePath === 'update') {
      const { PATCH } = await import('@/app/api/automations/[id]/route');
      response = await PATCH(
        new Request('http://localhost/api/automations/automation', {
          method: 'PATCH',
          body: JSON.stringify({ trigger_type: 'tag_added' }),
        }),
        params
      );
    } else {
      sourceTrigger = 'tag_added';
      storedSteps = [
        {
          id: 'condition',
          parent_step_id: null,
          branch: null,
          position: 0,
          step_type: 'condition',
          step_config: {},
        },
        {
          id: 'nested-action',
          parent_step_id: 'condition',
          branch: 'no',
          position: 0,
          ...action(),
        },
      ];
      const { POST } =
        await import('@/app/api/automations/[id]/duplicate/route');
      response = await POST(
        new Request('http://localhost/api/automations/automation/duplicate', {
          method: 'POST',
        }),
        params
      );
    }
    if (writePath === 'duplicate') {
      expect((await response.clone().json()).issues[0].path).toBe(
        'steps[0].no.steps[0].template_id'
      );
    }
    expect(response.status).toBe(400);
    expect((await response.json()).issues).toEqual([
      expect.objectContaining({
        message:
          'This template requires reservation context and cannot be used with this automation trigger.',
      }),
    ]);
  }
);
