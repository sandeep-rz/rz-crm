import { beforeEach, describe, expect, it, vi } from 'vitest';
import { engineSendTemplate, engineSendText } from './meta-send';
import type { PreparedTemplateMessage } from '@/lib/message-preparation/types';
import { buildMetaTemplateMessagePayload } from '@/lib/whatsapp/meta-template-payload';
const h = vi.hoisted(() => ({
  send: vi.fn(),
  text: vi.fn(),
  connection: vi.fn(),
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  lookup: vi.fn(),
  insertError: null as unknown,
  previewError: null as unknown,
  contact: {
    id: 'contact',
    phone: '+919876543210',
    wa_user_id: null,
  } as Record<string, unknown> | null,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: h.send,
  sendTextMessage: h.text,
}));
vi.mock('@/lib/whatsapp/connection-resolver', () => ({
  resolveWhatsAppConnection: h.connection,
}));
vi.mock('@/lib/whatsapp/conversation-scope', () => ({
  assertConversationInAccount: vi.fn(),
}));
vi.mock('@/lib/whatsapp/template-body', async (original) => ({
  ...(await original<object>()),
  resolveTemplateRow: h.lookup,
}));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: () => q,
        insert: (data: Record<string, unknown>) => {
          h.inserts.push(data);
          return q;
        },
        update: (data: Record<string, unknown>) => {
          h.updates.push(data);
          return q;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'contacts' ? h.contact : null,
            error:
              table === 'messages'
                ? h.insertError
                : table === 'conversations'
                  ? h.previewError
                  : null,
          }).then(resolve),
      };
      return q;
    },
  }),
}));
const prepared: PreparedTemplateMessage = {
  template: {
    id: 'template',
    name: 'booking',
    language: 'en_GB',
    connectionId: 'selected',
    body_text: 'Hi {{1}}, total {{2}}',
  },
  context: { reservationId: 'reservation' },
  resolvedVariables: {
    'contact.first_name': 'Guest from reservation',
    'reservation.total': '0',
  },
  mapping: [
    { component: 'BODY', position: 2, variable_key: 'reservation.total' },
    { component: 'BODY', position: 1, variable_key: 'contact.first_name' },
  ],
};
const args = () => ({
  accountId: 'account',
  userId: 'author',
  contactId: 'contact',
  conversationId: 'conversation',
  templateName: prepared.template.name,
  language: prepared.template.language,
  connectionId: 'selected',
  preparedTemplate: prepared,
  templatePayload: buildMetaTemplateMessagePayload(prepared),
});
beforeEach(() => {
  vi.resetAllMocks();
  h.inserts = [];
  h.updates = [];
  h.insertError = null;
  h.previewError = null;
  h.contact = { id: 'contact', phone: '+919876543210', wa_user_id: null };
  h.connection.mockResolvedValue({
    id: 'selected',
    phoneNumberId: 'phone-id',
    accessToken: 'secret',
    status: 'connected',
  });
  h.send.mockResolvedValue({ messageId: 'provider-id' });
});
describe('existing automation sender with semantic payload', () => {
  it('uses explicit credentials and assembled payload without name-based template lookup', async () => {
    await expect(engineSendTemplate(args())).resolves.toEqual({
      whatsapp_message_id: 'provider-id',
    });
    expect(h.connection).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'account',
      conversationId: 'conversation',
      connectionId: 'selected',
    });
    expect(h.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        phoneNumberId: 'phone-id',
        accessToken: 'secret',
        templatePayload: args().templatePayload,
      })
    );
    expect(h.lookup).not.toHaveBeenCalled();
  });
  it('persists substituted body and actual provider id/status in the existing inbox', async () => {
    await engineSendTemplate(args());
    expect(h.inserts).toEqual([
      {
        conversation_id: 'conversation',
        sender_type: 'bot',
        content_type: 'template',
        content_text: 'Hi Guest from reservation, total 0',
        template_name: 'booking',
        message_id: 'provider-id',
        status: 'sent',
      },
    ]);
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        last_message_text: 'Hi Guest from reservation, total 0',
        last_message_at: expect.any(String),
        updated_at: expect.any(String),
      })
    );
  });
  it('Meta rejection never inserts a sent message', async () => {
    h.send.mockRejectedValue(new Error('failed'));
    await expect(engineSendTemplate(args())).rejects.toThrow('failed');
    expect(h.inserts).toEqual([]);
  });
  it('known post-send persistence error is sanitized and terminal', async () => {
    h.insertError = { message: 'PRIVATE DATABASE DETAIL' };
    await expect(engineSendTemplate(args())).rejects.toMatchObject({
      code: 'meta_sent_message_persistence_failed',
      retryable: false,
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.updates).toEqual([]);
  });
  it('disconnected template connection blocks Meta', async () => {
    h.connection.mockResolvedValue({ status: 'disconnected' });
    await expect(engineSendTemplate(args())).rejects.toMatchObject({
      code: 'template_connection_not_connected',
      retryable: false,
    });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('BSUID recipient continues through existing recipient resolver', async () => {
    h.contact = { id: 'contact', phone: null, wa_user_id: 'US.12345678' };
    await engineSendTemplate(args());
    expect(h.send.mock.calls[0][0].to).toBe('US.12345678');
  });
  it.each([null, { id: 'contact', phone: null, wa_user_id: null }])(
    'unusable contact blocks sender',
    async (contact) => {
      h.contact = contact;
      await expect(engineSendTemplate(args())).rejects.toMatchObject({
        retryable: false,
      });
      expect(h.send).not.toHaveBeenCalled();
    }
  );
  it('text sending and persistence remain available', async () => {
    h.text.mockResolvedValue({ messageId: 'text-id' });
    await engineSendText({
      accountId: 'account',
      userId: 'author',
      conversationId: 'conversation',
      contactId: 'contact',
      text: 'Hello',
    });
    expect(h.text).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello', to: '919876543210' })
    );
    expect(h.inserts[0]).toMatchObject({
      content_text: 'Hello',
      content_type: 'text',
      message_id: 'text-id',
    });
    expect(h.lookup).not.toHaveBeenCalled();
  });
});

it('records Meta acceptance before any local persistence and preserves wamid on insert failure', async () => {
  h.insertError = { message: 'unavailable' };
  const onMetaAccepted = vi.fn(async (id: string) => {
    expect(id).toBe('provider-id');
    expect(h.inserts).toEqual([]);
    expect(h.updates).toEqual([]);
  });
  await expect(
    engineSendTemplate({ ...args(), onMetaAccepted })
  ).rejects.toMatchObject({
    code: 'meta_sent_message_persistence_failed',
    retryable: false,
  });
  expect(onMetaAccepted).toHaveBeenCalledOnce();
});
it('does not proceed with local persistence when acceptance evidence cannot be saved', async () => {
  await expect(
    engineSendTemplate({
      ...args(),
      onMetaAccepted: async () => {
        throw new Error('safety write failed');
      },
    })
  ).rejects.toThrow('safety write failed');
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.inserts).toEqual([]);
});

it('never calls Meta when the durable before-request guard fails', async () => {
  await expect(
    engineSendTemplate({
      ...args(),
      onBeforeMeta: async () => {
        throw new Error('guard unavailable');
      },
    })
  ).rejects.toThrow('guard unavailable');
  expect(h.send).not.toHaveBeenCalled();
  expect(h.inserts).toEqual([]);
});

it('persists the normalized BODY parameters sent to Meta instead of raw semantic values', async () => {
  const value = structuredClone(prepared);
  value.resolvedVariables['contact.first_name'] = 'Sandeep\nSharma\t';
  const templatePayload = buildMetaTemplateMessagePayload(value);
  await engineSendTemplate({
    ...args(),
    preparedTemplate: value,
    templatePayload,
  });
  expect(h.inserts[0].content_text).toBe('Hi Sandeep Sharma , total 0');
  expect(h.send).toHaveBeenCalledOnce();
});

it('preview failure after Meta acceptance is non-retryable and sends only once', async () => {
  h.previewError = { message: 'PRIVATE DB DETAIL' };
  await expect(engineSendTemplate(args())).rejects.toMatchObject({
    code: 'meta_sent_conversation_persistence_failed',
    retryable: false,
  });
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.inserts[0].message_id).toBe('provider-id');
});
