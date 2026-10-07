import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import { compileSemanticTemplate } from './semantic-template';
import { createBroadcast, deliverBroadcast } from './broadcast-core';
import { planBroadcastResume } from './broadcast-resume';
import { POST as sendBatch } from '@/app/api/whatsapp/broadcast/route';
import { POST as validate } from '@/app/api/whatsapp/broadcast/resolve-variables/route';
const h = vi.hoisted(() => ({
  send: vi.fn(),
  adapter: vi.fn(),
  contact: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<object>()),
  sendTemplateMessage: h.send,
}));
vi.mock('@/lib/integrations/pms/variable-registry', () => ({
  createConnectedVariableResolver: h.adapter,
}));
vi.mock('@/lib/whatsapp/connection-resolver', () => ({
  resolveWhatsAppConnection: async () => ({
    id: id(2),
    phoneNumberId: 'pn',
    accessToken: 'token',
  }),
}));
vi.mock('@/lib/api/v1/contacts', () => ({ findOrCreateContact: h.contact }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: db, accountId: id(1), userId: id(9) }),
  toErrorResponse: () =>
    Response.json({ error: 'Internal error' }, { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => {},
  RATE_LIMITS: { broadcast: {} },
}));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let reads: string[];
const catalog = [
  'contact.first_name',
  'workspace.name',
  'contact.phone',
  'listing.name',
].map((variableKey, i) => ({
  variableKey,
  label: variableKey,
  previewValue: 'APPROVAL SAMPLE',
  category: variableKey.split('.')[0] as 'contact' | 'workspace' | 'listing',
  isActive: true,
  sortOrder: i,
}));
function author(body: string) {
  const compiled = compileSemanticTemplate(
    { name: 'news', category: 'Marketing', language: 'en_US', body_text: '' },
    { body_text: body },
    catalog
  );
  return {
    ...compiled.transport,
    ...compiled.metadata,
    id: id(3),
    account_id: id(1),
    user_id: id(9),
    whatsapp_config_id: id(2),
    status: 'APPROVED',
    meta_template_id: 'meta',
  } as MessageTemplate;
}
const db = {
  from(table: string) {
    reads.push(table);
    if (table.startsWith('pms_'))
      throw new Error('No PMS integration or reservations exist');
    let patch: Row | undefined;
    let inserted: Row | undefined;
    const filters: Array<(row: Row) => boolean> = [];
    const response = () => {
      const rows = (tables[table] ?? []).filter((row) =>
        filters.every((f) => f(row))
      );
      if (patch) {
        rows.forEach((row) => Object.assign(row, patch));
        patch = undefined;
      }
      return {
        data: inserted ? [inserted] : rows,
        error: null,
        count: rows.length,
      };
    };
    const q = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return q;
      },
      in: (key: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[key]));
        return q;
      },
      update: (value: Row) => {
        patch = value;
        return q;
      },
      insert: (value: Row) => {
        inserted = value;
        (tables[table] ??= []).push(value);
        return q;
      },
      maybeSingle: async () => ({
        ...response(),
        data: response().data[0] ?? null,
      }),
      single: async () => ({ ...response(), data: response().data[0] ?? null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(response()).then(resolve),
    };
    return q;
  },
  rpc: async (_name: string, args: Row) => {
    tables.broadcasts = [
      {
        id: id(7),
        account_id: id(1),
        template_name: args.p_template_name,
        template_language: args.p_template_language,
      },
    ];
    tables.broadcast_recipients = (args.p_contact_ids as string[]).map(
      (contactId, i) => ({
        id: id(20 + i),
        broadcast_id: id(7),
        contact_id: contactId,
        contact: tables.contacts.find((v) => v.id === contactId),
        status: 'pending',
        template_params: (args.p_template_params as unknown[])[i],
      })
    );
    return {
      data: tables.broadcast_recipients.map((v) => ({
        broadcast_id: id(7),
        recipient_id: v.id,
        contact_id: v.contact_id,
      })),
      error: null,
    };
  },
} as unknown as SupabaseClient;
const request = (body: Row) =>
  new Request('http://localhost/api/whatsapp/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_name: 'news',
      template_language: 'en_US',
      whatsapp_config_id: id(2),
      ...body,
    }),
  });
const recipients = () =>
  tables.contacts.map((v) => ({
    phone: v.phone,
    contact_id: v.id,
    params: ['FORGED'],
    messageParams: { body: ['FORGED'] },
  }));
const sendTexts = () =>
  h.send.mock.calls.map(([args]) =>
    args.templatePayload.components[0].parameters.map(
      (p: { text: string }) => p.text
    )
  );
beforeEach(() => {
  vi.clearAllMocks();
  reads = [];
  tables = {
    message_templates: [
      author(
        'Hi {{contact.first_name}}, special news from {{workspace.name}}. We are happy to help you with your next visit. Please reply using {{contact.phone}}. Thank you again, {{contact.first_name}}.'
      ) as unknown as Row,
    ],
    message_variable_catalog: catalog.map((v) => ({
      variable_key: v.variableKey,
      label: v.label,
      preview_value: v.previewValue,
      source_scope: v.category,
      resolver_key: v.variableKey,
      resolution_source: v.category === 'workspace' ? 'crm' : 'context',
      category: v.category,
      is_active: true,
    })),
    contacts: [
      {
        id: id(4),
        account_id: id(1),
        name: 'Sandeep Sharma',
        phone: '+14155550123',
      },
      {
        id: id(5),
        account_id: id(1),
        name: 'Rahul Kumar',
        phone: '+14155550124',
      },
      {
        id: id(6),
        account_id: id(1),
        name: 'Ana Smith',
        phone: '+14155550125',
      },
    ],
    whatsapp_config: [{ id: id(2), account_id: id(1) }],
    accounts: [{ id: id(1), name: 'CRM\nTeam' }],
    broadcasts: [],
    broadcast_recipients: [],
  };
  h.send.mockResolvedValue({ messageId: 'wamid' });
  h.adapter.mockImplementation(() => {
    throw new Error('Provider calls are forbidden');
  });
  h.contact.mockImplementation(async (_db, _account, _user, args) => ({
    id: tables.contacts.find((c) => c.phone === args.phone)!.id,
  }));
});
it('sends independently prepared CRM-only dashboard payloads without PMS and ignores positional/preview values', async () => {
  const response = await sendBatch(
    request({ template_id: id(3), recipients: recipients() })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ sent: 3, failed: 0 });
  expect(sendTexts()).toEqual([
    ['Sandeep', 'CRM Team', '+14155550123', 'Sandeep'],
    ['Rahul', 'CRM Team', '+14155550124', 'Rahul'],
    ['Ana', 'CRM Team', '+14155550125', 'Ana'],
  ]);
  expect(h.send.mock.calls.map(([args]) => args.to)).toEqual([
    '14155550123',
    '14155550124',
    '14155550125',
  ]);
  expect(h.send.mock.calls[0][0].templatePayload).not.toBe(
    h.send.mock.calls[1][0].templatePayload
  );
  expect(
    h.send.mock.calls[0][0].templatePayload.components[0].parameters
  ).not.toBe(h.send.mock.calls[1][0].templatePayload.components[0].parameters);
  expect(JSON.stringify(h.send.mock.calls)).not.toMatch(
    /FORGED|APPROVAL SAMPLE/
  );
  expect(h.adapter).not.toHaveBeenCalled();
  expect(reads.some((v) => v.startsWith('pms_'))).toBe(false);
});
it('isolates a missing contact value between two successful dashboard recipients', async () => {
  tables.contacts[1].name = null;
  const response = await sendBatch(request({ recipients: recipients() }));
  const body = await response.json();
  expect(body).toMatchObject({ sent: 2, failed: 1 });
  expect(body.results.map((v: Row) => v.status)).toEqual([
    'sent',
    'failed',
    'sent',
  ]);
  expect(sendTexts().map((v) => v[0])).toEqual(['Sandeep', 'Ana']);
});
it('keeps the supplied broadcast destination separate from resolved contact.phone', async () => {
  await sendBatch(
    request({ recipients: [{ phone: '+14155550999', contact_id: id(4) }] })
  );
  expect(h.send.mock.calls[0][0].to).toBe('14155550999');
  expect(sendTexts()[0][2]).toBe('+14155550123');
});
it('rejects foreign/missing contact contexts without sending or falling back', async () => {
  tables.contacts[0].account_id = id(99);
  const response = await sendBatch(
    request({
      recipients: [
        { phone: '+14155550123', contact_id: id(4) },
        { phone: '+14155550124' },
      ],
    })
  );
  expect(await response.json()).toMatchObject({ sent: 0, failed: 2 });
  expect(h.send).not.toHaveBeenCalled();
});
it('blocks reservation-required templates before any contact creation or guessed reservation', async () => {
  tables.message_templates = [
    author(
      'Hello {{contact.first_name}}, your stay at {{listing.name}} is ready. We look forward to welcoming you soon.'
    ) as unknown as Row,
  ];
  await expect(
    createBroadcast(db, id(1), id(9), {
      templateName: 'news',
      whatsappConfigId: id(2),
      recipients: [{ to: '+14155550123' }],
    })
  ).rejects.toMatchObject({ code: 'template_context_required' });
  const response = await sendBatch(request({ recipients: recipients() }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('reservation context');
  expect(h.contact).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
  expect(reads.some((v) => v.startsWith('pms_'))).toBe(false);
});
it('uses real shared preparation for public API broadcasts and persists each recipient result', async () => {
  const plan = await createBroadcast(db, id(1), id(9), {
    templateName: 'news',
    whatsappConfigId: id(2),
    recipients: tables.contacts.map((v) => ({
      to: v.phone as string,
      params: ['FORGED'],
    })),
  });
  expect(tables.broadcasts[0].template_variables).toEqual({
    template_id: id(3),
  });
  tables.contacts[1].name = null;
  await deliverBroadcast(db, plan);
  expect(sendTexts().map((v) => v[0])).toEqual(['Sandeep', 'Ana']);
  expect(tables.broadcast_recipients.map((v) => v.status)).toEqual([
    'sent',
    'failed',
    'sent',
  ]);
  expect(tables.broadcast_recipients[0].whatsapp_message_id).toBe('wamid');
  expect(tables.broadcasts[0].status).toBe('sent');
  expect(h.adapter).not.toHaveBeenCalled();
});
it('reprepares pending/failed semantic recipients from current CRM data on resume rather than frozen values', async () => {
  await createBroadcast(db, id(1), id(9), {
    templateName: 'news',
    whatsappConfigId: id(2),
    recipients: [{ to: '+14155550123' }],
  });
  tables.contacts[0].name = 'Updated Name';
  tables.broadcast_recipients[0].template_params = ['FROZEN SAMPLE'];
  const { plan } = await planBroadcastResume(db, id(1), id(7), 'pending');
  expect(plan.planned[0].contactId).toBe(id(4));
  await deliverBroadcast(db, plan);
  expect(sendTexts()[0][0]).toBe('Updated');
  expect(JSON.stringify(h.send.mock.calls)).not.toContain('FROZEN SAMPLE');
});
it('never downgrades a saved semantic broadcast to legacy if its template loses configuration', async () => {
  await createBroadcast(db, id(1), id(9), {
    templateName: 'news',
    whatsappConfigId: id(2),
    recipients: [{ to: '+14155550123' }],
  });
  tables.message_templates[0].variable_configuration_status = 'needs_mapping';
  await expect(
    planBroadcastResume(db, id(1), id(7), 'pending')
  ).rejects.toMatchObject({ code: 'template_not_configured' });
  expect(h.send).not.toHaveBeenCalled();
});
it('preserves the legacy positional transport path for imported templates', async () => {
  tables.message_templates[0].variable_configuration_status = 'needs_mapping';
  await sendBatch(
    request({ recipients: [{ phone: '+14155550123', params: ['Legacy'] }] })
  );
  expect(h.send.mock.calls[0][0]).toMatchObject({ params: ['Legacy'] });
  expect(h.send.mock.calls[0][0].templatePayload).toBeUndefined();
  expect(reads).not.toContain('message_variable_catalog');
});
it('validates semantic authoring metadata without resolving or freezing recipient values', async () => {
  const response = await validate(
    request({ template_id: id(3), validate_only: true, mappings: ['FORGED'] })
  );
  expect(response.status).toBe(200);
  expect(reads).not.toContain('contacts');
  expect(h.adapter).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
});

it('inherits header/body/button assembly from the shared Meta payload builder', async () => {
  const compiled = compileSemanticTemplate(
    {
      name: 'news',
      category: 'Marketing',
      language: 'en_US',
      body_text: '',
      header_type: 'text',
      buttons: [
        { type: 'URL', text: 'Read more', url: 'https://example.test/{{1}}' },
      ],
    },
    {
      header_content: 'News from {{workspace.name}}',
      body_text:
        'Hi {{contact.first_name}}, we have some special news to share with you today. Please follow the link below to learn more.',
      button_urls: { '0': 'https://example.test/{{contact.first_name}}' },
    },
    catalog
  );
  tables.message_templates = [
    {
      ...tables.message_templates[0],
      ...compiled.transport,
      ...compiled.metadata,
    },
  ];
  await sendBatch(
    request({ recipients: [{ phone: '+14155550123', contact_id: id(4) }] })
  );
  expect(h.send.mock.calls[0][0].templatePayload.components).toEqual(
    expect.arrayContaining([
      { type: 'header', parameters: [{ type: 'text', text: 'CRM Team' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Sandeep' }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'Sandeep' }],
      },
    ])
  );
});
