import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import { compileSemanticTemplate, importedMetadata } from './semantic-template';
import { createBroadcast, deliverBroadcast } from './broadcast-core';
import { planBroadcastResume } from './broadcast-resume';
import { BROADCAST_DELIVERY_UNCONFIRMED } from './broadcast-delivery';
import { MetaApiError } from './meta-api';
import { persistBroadcastMessage } from './broadcast-message';
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
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: h.contact,
  resolveAuditUserId: async () => id(9),
}));
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
let failMessagePersistence = false;
let failClaim = false;
let failAcceptance = false;
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
      if (
        table === 'broadcast_recipients' &&
        ((failClaim &&
          patch?.error_message === BROADCAST_DELIVERY_UNCONFIRMED) ||
          (failAcceptance && patch?.whatsapp_message_id))
      )
        return {
          data: null,
          error: { message: 'database unavailable' },
          count: 0,
        };

      if (table === 'messages' && failMessagePersistence)
        return {
          data: null,
          error: { message: 'private database detail' },
          count: 0,
        };
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
      is: (key: string, value: unknown) => {
        filters.push((row) =>
          value === null ? row[key] == null : row[key] === value
        );
        return q;
      },
      or: (expression: string) => {
        const marker = expression.split('error_message.neq.')[1];
        filters.push(
          (row) => row.error_message == null || row.error_message !== marker
        );
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
        inserted = { id: id(100 + (tables[table]?.length ?? 0)), ...value };
        (tables[table] ??= []).push(inserted);
        return q;
      },
      upsert: (value: Row) => {
        if (
          !failMessagePersistence &&
          !(tables[table] ?? []).some(
            (row) =>
              row.conversation_id === value.conversation_id &&
              row.message_id === value.message_id
          )
        )
          (tables[table] ??= []).push(value);
        return q;
      },
      maybeSingle: async () => ({
        ...response(),
        data: response().data?.[0] ?? null,
      }),
      single: async () => ({
        ...response(),
        data: response().data?.[0] ?? null,
      }),
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
  failMessagePersistence = false;
  failClaim = false;
  failAcceptance = false;
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
  h.send.mockImplementation(async () => ({
    messageId: `wamid-${h.send.mock.calls.length}`,
  }));
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
it('blocks a supplied destination that differs from the semantic contact phone', async () => {
  await sendBatch(
    request({ recipients: [{ phone: '+14155550999', contact_id: id(4) }] })
  );
  expect(h.send).not.toHaveBeenCalled();
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
  expect(tables.broadcast_recipients[0].whatsapp_message_id).toBe('wamid-1');
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

for (const path of ['dashboard', 'worker'] as const) {
  async function deliverOne(phone = '+14155550123') {
    if (path === 'dashboard') {
      const response = await sendBatch(
        request({
          recipients: [{ contact_id: id(4), phone, params: ['Frozen'] }],
        })
      );
      return (await response.json()).results[0];
    }
    const plan = await createBroadcast(db, id(1), id(9), {
      templateName: 'news',
      whatsappConfigId: id(2),
      recipients: [{ to: '+14155550123', params: ['Frozen'] }],
    });
    plan.planned[0].phone = phone;
    await deliverBroadcast(db, plan);
    return tables.broadcast_recipients[0];
  }

  it(`${path}: allows formatting-equivalent contact phones and resolves the same contact`, async () => {
    const result = await deliverOne('1 (415) 555-0123');
    expect(result.status).toBe('sent');
    expect(h.send.mock.calls[0][0].to).toBe('14155550123');
    expect(sendTexts()[0]).toEqual([
      'Sandeep',
      'CRM Team',
      '+14155550123',
      'Sandeep',
    ]);
  });

  it.each(['foreign', 'missing', 'empty', 'invalid', 'lookup failure'])(
    `${path}: blocks %s contact before sending`,
    async (failure) => {
      // Build first to isolate send-time validation from contact creation.
      const plan = await createBroadcast(db, id(1), id(9), {
        templateName: 'news',
        recipients: [{ to: '+14155550123' }],
      });
      if (failure === 'foreign') tables.contacts[0].account_id = id(99);
      if (failure === 'missing') tables.contacts.shift();
      if (failure === 'empty') tables.contacts[0].phone = null;
      if (failure === 'invalid') tables.contacts[0].phone = '123';
      if (failure === 'lookup failure') {
        const original = db.from.bind(db);
        vi.spyOn(db, 'from').mockImplementation((table: string) => {
          if (table === 'contacts') throw new Error('private database error');
          return original(table);
        });
      }
      try {
        let result;
        if (path === 'worker') {
          await deliverBroadcast(db, plan);
          result = tables.broadcast_recipients[0];
        } else {
          const response = await sendBatch(
            request({
              recipients: [{ contact_id: id(4), phone: '+14155550123' }],
            })
          );
          result = (await response.json()).results[0];
        }
        expect(result.status).toBe('failed');
        expect(JSON.stringify(result)).not.toContain('private database error');
        expect(h.send).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    }
  );

  it(`${path}: blocks tampered destination without resolving personalized values`, async () => {
    const result = await deliverOne('+14155550124');
    expect(result.status).toBe('failed');
    expect(h.send).not.toHaveBeenCalled();
    expect(reads).not.toContain('accounts');
  });

  it(`${path}: blocks phone edits between recipient planning and delivery`, async () => {
    const plan = await createBroadcast(db, id(1), id(9), {
      templateName: 'news',
      recipients: [{ to: '+14155550123' }],
    });
    tables.contacts[0].phone = '+14155550999';
    if (path === 'worker') await deliverBroadcast(db, plan);
    else
      await sendBatch(
        request({ recipients: [{ contact_id: id(4), phone: '+14155550123' }] })
      );
    expect(h.send).not.toHaveBeenCalled();
  });

  it(`${path}: preserves matching legacy frozen params but blocks a conflicting contact destination`, async () => {
    tables.message_templates[0].variable_configuration_status = 'needs_mapping';
    expect((await deliverOne()).status).toBe('sent');
    expect(h.send.mock.calls[0][0]).toMatchObject({
      to: '14155550123',
      params: ['Frozen'],
    });
    expect(h.send.mock.calls[0][0].templatePayload).toBeUndefined();
    h.send.mockClear();
    expect((await deliverOne('+14155550124')).status).toBe('failed');
    expect(h.send).not.toHaveBeenCalled();
  });

  it(`${path}: does not try alternate phone numbers for contact-linked sends`, async () => {
    h.send.mockRejectedValue(new Error('131030 not in allowed list'));
    expect((await deliverOne()).status).toBe('failed');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].to).toBe('14155550123');
  });
}

it.each(['configured', 'needs_mapping'])(
  'rejects a fuzzy phone match before persisting %s recipient values',
  async (status) => {
    tables.message_templates[0].variable_configuration_status = status;
    h.contact.mockResolvedValue({ id: id(4) });
    await expect(
      createBroadcast(db, id(1), id(9), {
        templateName: 'news',
        recipients: [{ to: '+44155550123', params: ['Other contact'] }],
      })
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(tables.broadcast_recipients).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  }
);

it('persists two semantic recipients in their own normal connection-scoped Inbox conversations', async () => {
  const plan = await createBroadcast(db, id(1), id(9), {
    templateName: 'news',
    recipients: [{ to: '+14155550123' }, { to: '+14155550124' }],
  });
  await deliverBroadcast(db, plan);
  expect(tables.conversations).toHaveLength(2);
  for (const [index, contactId] of [id(4), id(5)].entries()) {
    const conversation = tables.conversations.find(
      (row) => row.contact_id === contactId
    )!;
    expect(conversation).toMatchObject({
      account_id: id(1),
      whatsapp_config_id: id(2),
    });
    const { data } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation.id);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      sender_type: 'agent',
      content_type: 'template',
      template_name: 'news',
      message_id: `wamid-${index + 1}`,
      status: 'sent',
    });
    expect(data![0].content_text).toContain(
      index === 0 ? 'Hi Sandeep' : 'Hi Rahul'
    );
    expect(data![0].content_text).not.toMatch(/\{\{/);
    expect(conversation.last_message_text).toBe(data![0].content_text);
    expect(conversation.last_message_at).toBeTruthy();
  }
  await deliverBroadcast(db, plan);
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(tables.messages).toHaveLength(2);
  expect(tables.broadcast_recipients.map((row) => row.status)).toEqual([
    'sent',
    'sent',
  ]);
});

it('dashboard persists accepted sends and does not resend an accepted recipient on reprocessing', async () => {
  await createBroadcast(db, id(1), id(9), {
    templateName: 'news',
    recipients: [{ to: '+14155550123' }],
  });
  const body = {
    broadcast_id: id(7),
    recipients: [
      { recipient_id: id(20), contact_id: id(4), phone: '+14155550123' },
    ],
  };
  expect((await (await sendBatch(request(body))).json()).sent).toBe(1);
  expect(tables.messages).toHaveLength(1);
  expect(tables.messages[0].content_text).toContain('Hi Sandeep');
  await sendBatch(request(body));
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(tables.messages).toHaveLength(1);
});

it.each(['dashboard', 'worker'])(
  '%s: local persistence failure preserves acceptance and blocks a retry send',
  async (path) => {
    const plan = await createBroadcast(db, id(1), id(9), {
      templateName: 'news',
      recipients: [{ to: '+14155550123' }],
    });
    const body = {
      broadcast_id: id(7),
      recipients: [
        { recipient_id: id(20), contact_id: id(4), phone: '+14155550123' },
      ],
    };
    failMessagePersistence = true;
    if (path === 'worker') await deliverBroadcast(db, plan);
    else {
      const result = await (await sendBatch(request(body))).json();
      expect(result).toMatchObject({
        sent: 1,
        failed: 0,
        results: [
          {
            status: 'sent',
            whatsapp_message_id: 'wamid-1',
            error: 'Sent to WhatsApp, but could not save to Inbox.',
          },
        ],
      });
    }
    expect(tables.broadcast_recipients[0]).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'wamid-1',
    });
    // Even an old browser incorrectly stamping failed must not authorize a resend.
    tables.broadcast_recipients[0].status = 'failed';
    failMessagePersistence = false;
    if (path === 'worker') await deliverBroadcast(db, plan);
    else await sendBatch(request(body));
    expect(h.send).toHaveBeenCalledTimes(1);
  }
);

it('dashboard cannot attach an accepted message to another account/broadcast recipient', async () => {
  await createBroadcast(db, id(1), id(9), {
    templateName: 'news',
    recipients: [{ to: '+14155550123' }],
  });
  const recipients = [
    { recipient_id: id(20), contact_id: id(5), phone: '+14155550124' },
  ];
  expect(
    (
      await (
        await sendBatch(request({ broadcast_id: id(7), recipients }))
      ).json()
    ).failed
  ).toBe(1);
  tables.broadcasts[0].account_id = id(99);
  expect(
    (await sendBatch(request({ broadcast_id: id(7), recipients }))).status
  ).toBe(404);
  expect(h.send).not.toHaveBeenCalled();
  expect(tables.messages ?? []).toEqual([]);
});

it('reuses the existing matching conversation and provider-id uniqueness without touching another connection', async () => {
  tables.conversations = [
    {
      id: id(90),
      account_id: id(1),
      contact_id: id(4),
      whatsapp_config_id: id(99),
    },
    {
      id: id(91),
      account_id: id(99),
      contact_id: id(4),
      whatsapp_config_id: id(2),
    },
    {
      id: id(92),
      account_id: id(1),
      contact_id: id(4),
      whatsapp_config_id: id(2),
    },
  ];
  const input = {
    accountId: id(1),
    connectionId: id(2),
    contactId: id(4),
    messageId: 'wamid-existing',
    templateName: 'news',
    contentText: 'Hi Sandeep',
  };
  await persistBroadcastMessage(db, input);
  await persistBroadcastMessage(db, input);
  expect(tables.conversations).toHaveLength(3);
  expect(tables.messages).toHaveLength(1);
  expect(tables.messages[0].conversation_id).toBe(id(92));
  expect(tables.conversations[0].last_message_text).toBeUndefined();
  expect(tables.conversations[1].last_message_text).toBeUndefined();
  expect(h.send).not.toHaveBeenCalled();
});

it('legacy frozen body values are rendered into the normal Inbox message', async () => {
  Object.assign(tables.message_templates[0], {
    variable_configuration_status: 'needs_mapping',
    body_text: 'Hi {{1}}, your update is ready.',
  });
  await sendBatch(
    request({
      recipients: [
        { contact_id: id(4), phone: '+14155550123', params: ['Sandeep'] },
      ],
    })
  );
  expect(tables.messages).toHaveLength(1);
  expect(tables.messages[0].content_text).toBe(
    'Hi Sandeep, your update is ready.'
  );
});

it('sends a synchronized static Meta import through dashboard and worker preparation with no mapping', async () => {
  const template = author('Thank you for contacting our team.');
  tables.message_templates = [
    { ...template, ...importedMetadata(template) } as unknown as Row,
  ];
  const response = await sendBatch(
    request({ recipients: [{ contact_id: id(4), phone: '+14155550123' }] })
  );
  expect(await response.json()).toMatchObject({ sent: 1, failed: 0 });
  const plan = await createBroadcast(db, id(1), id(9), {
    templateName: 'news',
    recipients: [{ to: '+14155550124' }],
  });
  await deliverBroadcast(db, plan);
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(
    h.send.mock.calls.map(([args]) => args.templatePayload.components)
  ).toEqual([undefined, undefined]);
  expect(tables.messages.map((row) => row.content_text)).toEqual([
    'Thank you for contacting our team.',
    'Thank you for contacting our team.',
  ]);
  expect(h.adapter).not.toHaveBeenCalled();
});

async function oneRecipientPlan() {
  return createBroadcast(db, id(1), id(9), {
    templateName: 'news',
    recipients: [{ to: '+14155550123' }],
  });
}
const durableBatch = () =>
  request({
    broadcast_id: id(7),
    recipients: [
      { recipient_id: id(20), contact_id: id(4), phone: '+14155550123' },
    ],
  });
it.each(['worker', 'dashboard'])(
  '%s atomically claims a recipient before the external boundary',
  async (path) => {
    const plan = await oneRecipientPlan();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.send.mockImplementation(async () => {
      await gate;
      return { messageId: 'wamid-concurrent' };
    });
    const first =
      path === 'worker'
        ? deliverBroadcast(db, plan)
        : sendBatch(durableBatch());
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    if (path === 'worker') await deliverBroadcast(db, plan);
    else await sendBatch(durableBatch());
    expect(h.send).toHaveBeenCalledOnce();
    release();
    await first;
    expect(tables.broadcast_recipients[0]).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'wamid-concurrent',
    });
    expect(tables.messages).toHaveLength(1);
  }
);
it.each(['worker', 'dashboard'])(
  '%s never reclaims an unconfirmed send after a timeout or restart',
  async (path) => {
    const plan = await oneRecipientPlan();
    h.send.mockRejectedValue(
      new Error('transport timeout with private content')
    );
    if (path === 'worker') await deliverBroadcast(db, plan);
    else await sendBatch(durableBatch());
    expect(tables.broadcast_recipients[0]).toMatchObject({
      status: 'failed',
      error_message: BROADCAST_DELIVERY_UNCONFIRMED,
    });
    h.send.mockResolvedValue({ messageId: 'must-not-send' });
    if (path === 'worker') await deliverBroadcast(db, plan);
    else await sendBatch(durableBatch());
    expect(h.send).toHaveBeenCalledOnce();
  }
);
it('allows intentional retry after a definite typed Meta rejection', async () => {
  const plan = await oneRecipientPlan();
  h.send.mockRejectedValueOnce(
    new MetaApiError('PRIVATE REJECTED CONTENT', { code: 100, httpStatus: 400 })
  );
  await deliverBroadcast(db, plan);
  expect(tables.broadcast_recipients[0].error_message).not.toBe(
    BROADCAST_DELIVERY_UNCONFIRMED
  );
  h.send.mockResolvedValue({ messageId: 'wamid-retry' });
  await deliverBroadcast(db, plan);
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(tables.broadcast_recipients[0].status).toBe('sent');
});
it('does not cross Meta when the durable recipient claim fails', async () => {
  const plan = await oneRecipientPlan();
  failClaim = true;
  await deliverBroadcast(db, plan);
  expect(h.send).not.toHaveBeenCalled();
});
it('keeps the durable unconfirmed guard if even the post-Meta acceptance write fails', async () => {
  const plan = await oneRecipientPlan();
  failAcceptance = true;
  await deliverBroadcast(db, plan);
  failAcceptance = false;
  await deliverBroadcast(db, plan);
  expect(h.send).toHaveBeenCalledOnce();
  expect(tables.broadcast_recipients[0].error_message).toBe(
    BROADCAST_DELIVERY_UNCONFIRMED
  );
});
it.each(['sent', 'delivered', 'read', 'replied'])(
  'never resends a terminal %s recipient even without a wamid',
  async (status) => {
    const plan = await oneRecipientPlan();
    tables.broadcast_recipients[0].status = status;
    await deliverBroadcast(db, plan);
    expect(h.send).not.toHaveBeenCalled();
    expect(tables.broadcast_recipients[0].status).toBe(status);
  }
);
