import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import { compileSemanticTemplate } from './semantic-template';
import { sendMessageToConversation } from './send-message';
import { executeAutomationStep } from '@/lib/automations/engine';
const h = vi.hoisted(() => ({ resolver: vi.fn(), send: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/message-variables/runtime-resolver', () => ({
  resolveRuntimeVariables: h.resolver,
}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<object>()),
  sendTemplateMessage: h.send,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => db }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => db }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = id(1),
  configId = id(2),
  reservation = id(3),
  templateId = id(4),
  conversationId = id(5);
const actual = {
  'contact.first_name': 'Taylor',
  'reservation.reference': 'RZ26100711c3',
  'listing.name': 'Sea House',
  'property.staff_details': 'Reception: Ana\nNight team: Ben',
  'contact.phone': '+19999999999',
};
const catalog = [...Object.keys(actual), 'workspace.name'].map(
  (variableKey, sortOrder) => ({
    variableKey,
    label: variableKey,
    previewValue: 'APPROVAL SAMPLE',
    isActive: true,
    category: 'contact' as const,
    sortOrder,
  })
);
let template: MessageTemplate;
let writes: Record<string, unknown>[];
let reads: string[];
let providerTables: Record<string, Record<string, unknown>>;
const config = {
  id: configId,
  account_id: account,
  access_token: 'token',
  phone_number_id: 'pn',
  is_primary: true,
  status: 'connected',
};
const conversation = {
  id: conversationId,
  account_id: account,
  whatsapp_config_id: configId,
  contact_id: id(8),
  contact: {
    id: id(8),
    account_id: account,
    name: 'Taylor Jane',
    phone: '+15551234567',
    email: 'taylor@example.test',
  },
};
const db = {
  from(table: string) {
    reads.push(table);
    if (table.startsWith('pms_') && !providerTables[table])
      throw new Error('No PMS tables exist in this workspace');
    const filters: [string, unknown][] = [];
    let inserted: Record<string, unknown> | undefined;
    const row = () =>
      table === 'message_templates'
        ? template
        : table === 'whatsapp_config'
          ? config
          : table === 'conversations'
            ? conversation
            : table === 'contacts'
              ? conversation.contact
              : table === 'accounts'
                ? { id: account, name: 'CRM Workspace' }
                : (providerTables[table] ?? null);
    const matched = () => {
      const data = row();
      return data &&
        filters.every(
          ([key, value]) =>
            (data as unknown as Record<string, unknown>)[key] === value
        )
        ? data
        : null;
    };
    const q = {
      select: () => q,
      order: () => q,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return q;
      },
      insert: (data: Record<string, unknown>) => {
        inserted = data;
        writes.push(data);
        return q;
      },
      update: () => q,
      maybeSingle: async () => ({ data: matched(), error: null }),
      single: async () => ({
        data: inserted ? { ...inserted, id: id(9) } : matched(),
        error: null,
      }),
      limit: async () => ({ data: matched() ? [matched()] : [], error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === 'message_variable_catalog'
              ? [
                  ...catalog,
                  {
                    variableKey: 'workspace.name',
                    label: 'Workspace name',
                    previewValue: 'APPROVAL SAMPLE',
                    category: 'workspace',
                    isActive: true,
                    sortOrder: 99,
                  },
                ].map((v) => ({
                  variable_key: v.variableKey,
                  resolver_key: v.variableKey,
                  source_scope: v.variableKey.split('.')[0],
                  resolution_source:
                    v.variableKey === 'workspace.name' ? 'crm' : 'context',
                  is_active: true,
                }))
              : table === 'message_templates' && matched()
                ? [matched()]
                : null,
          error: null,
        }).then(resolve),
    };
    return q;
  },
} as unknown as SupabaseClient;
function author(body: string) {
  const compiled = compileSemanticTemplate(
    {
      name: 'booking_confirmed',
      category: 'Utility',
      language: 'en_US',
      body_text: '',
    },
    { body_text: body, button_urls: {} },
    catalog
  );
  template = {
    ...compiled.transport,
    ...compiled.metadata,
    id: templateId,
    account_id: account,
    user_id: id(7),
    whatsapp_config_id: configId,
    status: 'APPROVED',
    meta_template_id: 'meta-approved',
  } as MessageTemplate;
}
const send = (reservationId?: string, byName = false) =>
  sendMessageToConversation(
    db,
    account,
    {
      conversationId,
      messageType: 'template',
      templateName: byName ? 'booking_confirmed' : 'FORGED_CLIENT_NAME',
      templateParams: ['FORGED CLIENT VALUE'],
      contentText: 'FORGED CLIENT BODY',
    },
    { ...(byName ? {} : { templateId }), reservationId }
  );
beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  reads = [];
  providerTables = {};
  author(
    'Hi {{contact.first_name}}, your booking {{reservation.reference}} at {{listing.name}} is confirmed. Your team: {{property.staff_details}}. Your booking phone is {{contact.phone}}.'
  );
  h.send.mockResolvedValue({ messageId: 'wamid-test' });
  h.resolver.mockImplementation(async (input) =>
    !input.context.reservationId && input.variableKeys.length
      ? {
          success: false,
          invalidKeys: [],
          values: {},
          failures: [
            {
              code: 'reservation_context_required',
              source: 'context',
              variableKeys: input.variableKeys,
              retryable: false,
            },
          ],
        }
      : {
          success: true,
          invalidKeys: [],
          failures: [],
          values: Object.fromEntries(
            input.variableKeys.map((key: keyof typeof actual) => [
              key,
              { status: 'resolved', source: 'provider', value: actual[key] },
            ])
          ),
        }
  );
});
it('reuses real preparation/assembly, keeps recipient separate, and persists runtime values', async () => {
  const result = await send(reservation);
  expect(h.resolver).toHaveBeenCalledTimes(1);
  expect(h.resolver.mock.calls[0][0]).toMatchObject({
    accountId: account,
    context: { reservationId: reservation },
    variableKeys: Object.keys(actual),
  });
  const args = h.send.mock.calls[0][0];
  expect(args.to).toBe('15551234567');
  expect(args.to).not.toBe(actual['contact.phone']);
  expect(args.templatePayload.name).toBe('booking_confirmed');
  expect(
    args.templatePayload.components[0].parameters.map(
      (p: { text: string }) => p.text
    )
  ).toEqual([
    'Taylor',
    'RZ26100711c3',
    'Sea House',
    'Reception: Ana Night team: Ben',
    '+19999999999',
  ]);
  expect(writes[0].conversation_id).toBe(conversationId);
  expect(writes[0].content_text).toContain('Taylor');
  expect(writes[0].content_text).toContain('Sea House');
  expect(writes[0].content_text).toContain('Reception: Ana Night team: Ben');
  expect(JSON.stringify(writes)).not.toMatch(/APPROVAL SAMPLE|FORGED/);
  expect(result.contentText).toBe(writes[0].content_text);
});
it('also migrates dashboard name-only requests for configured templates', async () => {
  await send(reservation, true);
  expect(h.resolver).toHaveBeenCalledTimes(1);
  expect(h.send.mock.calls[0][0].templatePayload).toBeDefined();
});
it('missing reservation blocks send without creating a message', async () => {
  await expect(send()).rejects.toMatchObject({
    code: 'runtime_resolution_failure',
    diagnostics: {
      runtimeFailures: [
        expect.objectContaining({ code: 'reservation_context_required' }),
      ],
    },
  });
  expect(h.send).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
});
it.each(['missing', 'unsupported'])(
  'blocks %s runtime information cleanly',
  async (status) => {
    h.resolver.mockResolvedValue({
      success: true,
      invalidKeys: [],
      failures: [],
      values: Object.fromEntries(
        Object.keys(actual).map((key) => [key, { status, value: null }])
      ),
    });
    await expect(send(reservation)).rejects.toMatchObject({
      code: status === 'missing' ? 'variable_missing' : 'variable_unsupported',
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  }
);
it('needs_mapping retains legacy positional sending and never enters semantic preparation', async () => {
  template.variable_configuration_status = 'needs_mapping';
  await send(reservation);
  expect(h.resolver).not.toHaveBeenCalled();
  expect(h.send.mock.calls[0][0].templatePayload).toBeUndefined();
  expect(h.send.mock.calls[0][0].params).toEqual(['FORGED CLIENT VALUE']);
});
it('a static configured template does not require reservation context', async () => {
  author('Thank you for your message. We will get back to you shortly.');
  await send();
  expect(h.resolver.mock.calls[0][0].variableKeys).toEqual([]);
  expect(h.send).toHaveBeenCalledTimes(1);
});
it('rejects a template from a different workspace/connection before resolution', async () => {
  template.account_id = id(99);
  await expect(send(reservation)).rejects.toMatchObject({
    code: 'template_not_found',
  });
  expect(h.resolver).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
});
it('other consumers remain on their existing path unless the dashboard opts in', async () => {
  await sendMessageToConversation(db, account, {
    conversationId,
    messageType: 'template',
    templateName: 'booking_confirmed',
    templateParams: ['Existing'],
  });
  expect(h.resolver).not.toHaveBeenCalled();
  expect(h.send.mock.calls[0][0].templatePayload).toBeUndefined();
});

async function crmOnlyPipeline() {
  const { resolveRuntimeVariables } = await vi.importActual<
    typeof import('@/lib/message-variables/runtime-resolver')
  >('@/lib/message-variables/runtime-resolver');
  h.resolver.mockImplementation(resolveRuntimeVariables);
  author(
    'Hi {{contact.first_name}}, welcome to {{workspace.name}}. Our team is happy to help you.'
  );
  expect(template.body_text).toBe(
    'Hi {{1}}, welcome to {{2}}. Our team is happy to help you.'
  );
  expect(
    template.semantic_variable_mapping?.map((v) => v.variable_key)
  ).toEqual(['contact.first_name', 'workspace.name']);
}
it('runs authoring, real preparation/resolution, Meta assembly, manual sending and persistence with no PMS', async () => {
  await crmOnlyPipeline();
  const result = await send();
  expect(
    h.send.mock.calls[0][0].templatePayload.components[0].parameters
  ).toEqual([
    { type: 'text', text: 'Taylor' },
    { type: 'text', text: 'CRM Workspace' },
  ]);
  expect(result.contentText).toBe(
    'Hi Taylor, welcome to CRM Workspace. Our team is happy to help you.'
  );
  expect(writes[0].content_text).toBe(result.contentText);
  expect(reads.some((t) => t.startsWith('pms_'))).toBe(false);
});
it.each(['new_contact_created', 'tag_added'] as const)(
  'executes the real CRM-only automation send and persistence for %s without PMS',
  async (triggerEvent) => {
    await crmOnlyPipeline();
    await executeAutomationStep(
      {
        id: id(44),
        step_type: 'send_template',
        step_config: { template_id: templateId },
      } as Parameters<typeof executeAutomationStep>[0],
      {
        automation: {
          id: id(45),
          account_id: account,
          user_id: id(7),
          whatsapp_config_id: configId,
        },
        contactId: id(8),
        context: { conversation_id: conversationId },
        triggerEvent,
      } as Parameters<typeof executeAutomationStep>[1]
    );
    expect(h.send).toHaveBeenCalledOnce();
    expect(
      h.send.mock.calls[0][0].templatePayload.components[0].parameters[0]
    ).toEqual({ type: 'text', text: 'Taylor' });
    expect(writes[0].content_text).toBe(
      'Hi Taylor, welcome to CRM Workspace. Our team is happy to help you.'
    );
    expect(reads.some((t) => t.startsWith('pms_'))).toBe(false);
  }
);

it('keeps reservation-confirmation sends on one provider bulk call with booking guest precedence', async () => {
  const { resolveRuntimeVariables } = await vi.importActual<
    typeof import('@/lib/message-variables/runtime-resolver')
  >('@/lib/message-variables/runtime-resolver');
  providerTables = {
    pms_reservations: {
      id: reservation,
      account_id: account,
      pms_integration_id: id(61),
      pms_property_id: id(62),
      external_reservation_id: id(63),
      metadata: { source_type: 'pms_bookings' },
    },
    pms_properties: {
      id: id(62),
      account_id: account,
      pms_integration_id: id(61),
      external_property_id: 'property-external',
      status: 'active',
    },
    pms_integrations: {
      id: id(61),
      account_id: account,
      provider: 'rukiye_zara',
      external_account_id: 'owner',
      status: 'connected',
    },
  };
  const bulk = vi.fn(async ({ variableKeys }: { variableKeys: string[] }) =>
    Object.fromEntries(
      variableKeys.map((key) => [
        key,
        {
          status: 'resolved' as const,
          value: actual[key as keyof typeof actual],
        },
      ])
    )
  );
  h.resolver.mockImplementation((input, options) =>
    resolveRuntimeVariables(input, {
      ...options,
      createAdapter: () => ({ resolveVariables: bulk }),
    })
  );
  await executeAutomationStep(
    {
      id: id(44),
      step_type: 'send_template',
      step_config: { template_id: templateId },
    } as Parameters<typeof executeAutomationStep>[0],
    {
      automation: {
        id: id(45),
        account_id: account,
        user_id: id(7),
        whatsapp_config_id: configId,
      },
      contactId: id(8),
      context: { reservation: { reservation_id: reservation } },
      triggerEvent: 'reservation_confirmed',
    } as Parameters<typeof executeAutomationStep>[1]
  );
  expect(bulk).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ variableKeys: Object.keys(actual) })
  );
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.send.mock.calls[0][0].to).toBe('15551234567');
  expect(
    h.send.mock.calls[0][0].templatePayload.components[0].parameters[3]
  ).toEqual({ type: 'text', text: 'Reception: Ana Night team: Ben' });
  expect(writes[0].content_text).toContain('Reception: Ana\nNight team: Ben');
  expect(writes[0].content_text).toContain('+19999999999');
});
