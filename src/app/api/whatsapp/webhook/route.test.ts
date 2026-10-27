import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processWebhook } from '@/lib/whatsapp/webhook-processor';

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    deliveryOwned: false,
    historyPromoted: false,
    receiptContext: null as Record<string, unknown> | null,
    failInbox: false,
    deletedConversation: false,
    deletionLookupError: false,
    statusResult: null as Record<string, unknown> | null,
    /** Row `lookupInternalIdByMetaId` resolves for a `context.id`. */
    replyContextParent: null as { id: string } | null,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string;
      path: string;
      options: { contentType?: string };
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
    /** Row `findContactByWaUserId` resolves for a BSUID lookup (#519). */
    contactByWaUserId: null as Record<string, unknown> | null,
    /** Rows inserted into `contacts`. */
    contactInserts: [] as Record<string, unknown>[],
    /** Patches applied to an existing `contacts` row. */
    contactUpdates: [] as Record<string, unknown>[],
    /** Patches applied to `messages` by a status webhook (#535). */
    messageUpdates: [] as Record<string, unknown>[],
    /** Row the status webhook's broadcast_recipients lookup resolves. */
    broadcastRecipient: null as { id: string; status: string } | null,
    /** Patches applied to that broadcast_recipients row. */
    recipientUpdates: [] as Record<string, unknown>[],
  },
}));

vi.mock('@/lib/whatsapp/webhook-runtime', () => ({
  captureWhatsAppDelivery: vi.fn(async (_db, body) => {
    (h.state as unknown as { payload: unknown }).payload = body;
  }),
  runWhatsAppWorker: vi.fn(async () => {
    await processWebhook((h.state as unknown as { payload: never }).payload);
  }),
  deliveryStage: async (
    _db: unknown,
    _receipt: unknown,
    _stage: unknown,
    action: () => Promise<unknown>
  ) => action(),
}));
vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'config-1',
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      access_token: 'enc',
                      mirror_inbound_media: h.state.mirrorInboundMedia,
                    },
                  ],
                  error: null,
                }),
            }),
          };
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().eq().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () =>
                        Promise.resolve({
                          data: [h.state.conversation],
                          error: null,
                        }),
                    }),
                  }),
                }),
              }),
            }),
          };
        case 'broadcast_recipients':
          // Two chains land here:
          //   flagBroadcastReplyIfAny: select().eq().eq().in().order().limit()
          //   handleStatusUpdate:      select().eq().maybeSingle(), then
          //                            update().eq()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    in: () => ({
                      order: () => ({
                        limit: () => Promise.resolve({ data: [], error: null }),
                      }),
                    }),
                  }),
                }),
                maybeSingle: () =>
                  Promise.resolve({
                    data: h.state.broadcastRecipient,
                    error: null,
                  }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              h.state.recipientUpdates.push(patch);
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        case 'contacts':
          // Three chains land here, all from findOrCreateContact:
          //   findContactByWaUserId: select('*').eq().eq().maybeSingle()
          //   identity backfill:     update().eq().select().maybeSingle()
          //   create:                insert().select().single()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: h.state.contactByWaUserId,
                      error: null,
                    }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              h.state.contactUpdates.push(patch);
              return {
                eq: () => ({
                  select: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: null, error: null }),
                  }),
                }),
              };
            },
            insert: (row: Record<string, unknown>) => {
              h.state.contactInserts.push(row);
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: { id: 'contact-new', ...row },
                      error: null,
                    }),
                }),
              };
            },
          };
        case 'messages':
          return {
            // Two different chains land here, told apart by the count
            // option: the prior-message count (head request) and the
            // reply-context parent lookup.
            select: (_columns: string, options?: { head?: boolean }) =>
              options?.head
                ? // priorCustomerMsgCount: select('id',{count,head}).eq().eq()
                  {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({
                          count: h.state.priorCustomerMsgCount,
                          error: null,
                        }),
                    }),
                  }
                : // lookupInternalIdByMetaId: select('id').eq().eq().maybeSingle()
                  // handleStatusUpdate fan-out: select().eq().limit().maybeSingle()
                  {
                    eq: () => ({
                      eq: () => ({
                        eq: () => ({
                          maybeSingle: async () => ({
                            data: h.state.deliveryOwned
                              ? { id: 'msg-1' }
                              : null,
                            error: null,
                          }),
                        }),
                        maybeSingle: () =>
                          Promise.resolve({
                            data: h.state.replyContextParent,
                            error: null,
                          }),
                      }),
                      limit: () => ({
                        maybeSingle: () =>
                          Promise.resolve({ data: null, error: null }),
                      }),
                    }),
                  },
            // Status webhook mirror (#535): update(...).eq('message_id', ...)
            update: (patch: Record<string, unknown>) => {
              h.state.messageUpdates.push(patch);
              const result = Promise.resolve({
                data: h.state.historyPromoted ? [{ id: 'msg-1' }] : [],
                error: null,
              });
              const q = {
                eq: () => q,
                in: () => q,
                select: () => result,
                then: result.then.bind(result),
              };
              return q;
            },
            // Idempotent insert: upsert(...).select('id')
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options });
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              };
            },
          };
        default:
          throw new Error(`unexpected table: ${table}`);
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args });
      if (name === 'is_deleted_conversation_message')
        return Promise.resolve({
          data: h.state.deletedConversation,
          error: h.state.deletionLookupError ? { code: 'down' } : null,
        });
      if (name === 'apply_whatsapp_status')
        return Promise.resolve({ data: h.state.statusResult, error: null });
      if (name === 'whatsapp_delivery_context') {
        h.state.receiptContext ??= args.p_context as Record<string, unknown>;
        return Promise.resolve({ data: h.state.receiptContext, error: null });
      }
      if (name === 'apply_whatsapp_inbound' && h.state.failInbox)
        return Promise.resolve({ data: null, error: { code: 'down' } });
      return Promise.resolve({ data: null, error: null });
    },
    // Service-role Storage, used by the inbound-media mirror (#466).
    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: { contentType?: string }
          ) => {
            h.state.storageUploads.push({ bucket, path, options });
            return Promise.resolve({ error: h.state.storageUploadError });
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        };
      },
    },
  }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}));

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
  verifyTokenMatches: (a: string, b: string) => a === b,
}));
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: (field: string) =>
    field.startsWith('message_template_'),
  handleTemplateWebhookChange: vi.fn(),
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}));

import { POST } from './route';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { findExistingContact } from '@/lib/contacts/dedupe';
import { handleTemplateWebhookChange } from '@/lib/whatsapp/template-webhook';

const mockGetMediaUrl = vi.mocked(getMediaUrl);
const mockDownloadMedia = vi.mocked(downloadMedia);
const mockFindExistingContact = vi.mocked(findExistingContact);

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
};

const LEGACY_CONTACTS = [{ wa_id: '15551230000', profile: { name: 'Ada' } }];

function inboundRequest(
  message: Record<string, unknown> = TEXT_MESSAGE,
  contacts: Record<string, unknown>[] = LEGACY_CONTACTS
) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: 'pn-1',
                display_phone_number: '15551234567',
              },
              contacts,
              messages: [message],
            },
          },
        ],
      },
    ],
  };
  return new Request('https://crm.test/api/whatsapp/webhook', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'x-hub-signature-256': 'sha256=stub' },
  });
}

async function runWebhook(
  message?: Record<string, unknown>,
  contacts?: Record<string, unknown>[]
) {
  const res = await POST(inboundRequest(message, contacts));
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb();
  return res;
}

/** A message-status webhook (sent / delivered / read / failed). */
async function runStatusWebhook(status: Record<string, unknown>) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: 'pn-1',
                display_phone_number: '15551234567',
              },
              statuses: [status],
            },
          },
        ],
      },
    ],
  };
  const res = await POST(
    new Request('https://crm.test/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'x-hub-signature-256': 'sha256=stub' },
    })
  );
  for (const cb of h.state.afterCallbacks) await cb();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.messageUpsertResult = [{ id: 'msg-1' }];
  h.state.priorCustomerMsgCount = 0;
  h.state.deliveryOwned = false;
  h.state.historyPromoted = false;
  h.state.receiptContext = null;
  h.state.failInbox = false;
  h.state.deletedConversation = false;
  h.state.deletionLookupError = false;
  h.state.replyContextParent = null;
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' };
  h.state.upsertCalls = [];
  h.state.rpcCalls = [];
  h.state.afterCallbacks = [];
  h.state.automationStarted = 0;
  h.state.automationCompleted = 0;
  h.state.mirrorInboundMedia = true;
  h.state.storageUploads = [];
  h.state.storageUploadError = null;
  h.state.contactByWaUserId = null;
  h.state.contactInserts = [];
  h.state.contactUpdates = [];
  h.state.messageUpdates = [];
  h.state.broadcastRecipient = null;
  h.state.statusResult = null;
  h.state.recipientUpdates = [];
  mockFindExistingContact.mockResolvedValue({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  });
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  });
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  });
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false });
  h.dispatchInboundToAiReply.mockResolvedValue(undefined);
  h.dispatchWebhookEvent.mockResolvedValue(undefined);
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++;
        resolve();
      }, 0);
    });
  });
});

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook();

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    });
    // Downstream side effects ran exactly once.
    expect(
      h.state.rpcCalls.filter(
        (call) => call.name === 'bump_conversation_on_inbound'
      )
    ).toHaveLength(1);
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1);
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = [];

    await runWebhook();

    expect(h.state.upsertCalls).toHaveLength(1);
    // None of the downstream side effects fire on a replay.
    expect(
      h.state.rpcCalls.filter(
        (call) => call.name !== 'is_deleted_conversation_message'
      )
    ).toHaveLength(0);
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('inbound webhook: deleted chat replay protection', () => {
  it('drops old deliveries before message writes and automatic replies', async () => {
    h.state.deletedConversation = true;
    await runWebhook();
    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.state.rpcCalls[0].name).toBe('is_deleted_conversation_message');
  });
  it('fails closed when the cutoff lookup fails', async () => {
    h.state.deletionLookupError = true;
    await runWebhook();
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.state.upsertCalls).toHaveLength(0);
  });
});

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook();

    expect(
      h.state.rpcCalls.filter(
        (call) => call.name === 'bump_conversation_on_inbound'
      )
    ).toHaveLength(1);
    expect(
      h.state.rpcCalls.find(
        (call) => call.name === 'bump_conversation_on_inbound'
      )
    ).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1' },
    });
  });
});

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  // `context.id` points at the template message we sent — which the
  // broadcast path never wrote to `messages`, so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  };

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap);

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    });
  });

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(templateButtonTap);

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'wamid.BTN1',
        },
      })
    );
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType
    );
    expect(triggers).toContain('interactive_reply');
    // The AI auto-reply must stay out of it — a button tap is not a
    // free-text question.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
  });

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    });

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'Track my order',
    });
  });
});

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  };

  it('stores a durable bucket URL instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.storageUploads).toHaveLength(1);
    expect(h.state.storageUploads[0].bucket).toBe('chat-media');
    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-image-1700000000.jpg'
    );
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      media_type: 'image/jpeg',
    });
  });

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' };

    await runWebhook(IMAGE_MESSAGE);

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        '/api/whatsapp/media/1234567890123456?whatsapp_config_id=config-1',
      media_type: 'image/jpeg',
    });
  });

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(
      new Error('Media download failed: 404')
    );

    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        '/api/whatsapp/media/1234567890123456?whatsapp_config_id=config-1',
    });
  });

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    });

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    });

    expect(mockDownloadMedia).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/999?whatsapp_config_id=config-1',
      media_type: 'application/pdf',
    });
  });

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    });
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    });

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    });

    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-invoice.pdf'
    );
  });

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false;

    await runWebhook(IMAGE_MESSAGE);

    expect(mockDownloadMedia).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        '/api/whatsapp/media/1234567890123456?whatsapp_config_id=config-1',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      media_type: 'image/jpeg',
    });
  });

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined;

    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.storageUploads).toHaveLength(1);
  });

  it('leaves text messages alone', async () => {
    await runWebhook();

    expect(mockGetMediaUrl).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({ media_type: null });
  });
});

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook();

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3);
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3);
  });
});

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta stopped sending the phone number for a customer who has adopted
// a WhatsApp username: `messages[].from` and `contacts[].wa_id` are
// both absent, and only `from_user_id` / `user_id` identify them.
//
// Before the fix, `normalizePhone(undefined)` gave '', which
// `findExistingContact` refuses to look up, so every such delivery
// inserted a NEW contact — and migration 022's unique index is partial
// (`WHERE phone_normalized <> ''`) so nothing stopped it. One contact
// and one conversation per inbound message.
// ============================================================

const USERNAME_ONLY_MESSAGE = {
  id: 'wamid.BSUID1',
  from_user_id: 'US.13491208655302741918',
  from_parent_user_id: 'US.ENT.11815799212886844830',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'does it come in another color?' },
};

const USERNAME_ONLY_CONTACTS = [
  {
    profile: { name: 'Sheena Nelson', username: 'realsheenanelson' },
    user_id: 'US.13491208655302741918',
    parent_user_id: 'US.ENT.11815799212886844830',
  },
];

describe('inbound webhook: business-scoped user IDs (#519)', () => {
  it('creates ONE contact keyed on the BSUID when Meta sends no phone', async () => {
    // Nothing on file under either key yet.
    h.state.contactByWaUserId = null;
    mockFindExistingContact.mockResolvedValue(null);

    await runWebhook(USERNAME_ONLY_MESSAGE, USERNAME_ONLY_CONTACTS);

    expect(h.state.contactInserts).toHaveLength(1);
    expect(h.state.contactInserts[0]).toMatchObject({
      account_id: 'acc-1',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'realsheenanelson',
      name: 'Sheena Nelson',
    });
    // The message still lands in the thread.
    expect(h.state.upsertCalls).toHaveLength(1);
  });

  it('never looks the sender up by phone when there is no phone', async () => {
    h.state.contactByWaUserId = null;
    mockFindExistingContact.mockResolvedValue(null);

    await runWebhook(USERNAME_ONLY_MESSAGE, USERNAME_ONLY_CONTACTS);

    // The old code called this with '' and got null every time, which
    // is exactly how the duplicate contacts got created.
    expect(mockFindExistingContact).not.toHaveBeenCalled();
  });

  it('reuses the existing contact on the SECOND message from the same BSUID', async () => {
    // The row the first message created.
    h.state.contactByWaUserId = {
      id: 'contact-bsuid',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'realsheenanelson',
    };
    mockFindExistingContact.mockResolvedValue(null);

    await runWebhook(
      { ...USERNAME_ONLY_MESSAGE, id: 'wamid.BSUID2' },
      USERNAME_ONLY_CONTACTS
    );

    expect(h.state.contactInserts).toHaveLength(0);
    // Nothing about the identity changed, so no pointless UPDATE either.
    expect(h.state.contactUpdates).toHaveLength(0);
  });

  it('backfills the BSUID onto a contact we already knew by phone', async () => {
    // Transition payload: Meta sends both keys. We match on the phone
    // and stamp the BSUID so the next phone-less message still finds
    // this row instead of forking a new one.
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Pablo',
      phone: '16505551234',
    });

    await runWebhook(
      {
        id: 'wamid.BOTH',
        from: '16505551234',
        from_user_id: 'US.13491208655302741918',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hi' },
      },
      [
        {
          profile: { name: 'Pablo', username: 'pablomorales' },
          wa_id: '16505551234',
          user_id: 'US.13491208655302741918',
        },
      ]
    );

    expect(h.state.contactInserts).toHaveLength(0);
    expect(h.state.contactUpdates).toHaveLength(1);
    expect(h.state.contactUpdates[0]).toMatchObject({
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'pablomorales',
    });
    // The number we already had is left alone.
    expect(h.state.contactUpdates[0]).not.toHaveProperty('phone');
  });

  it('fills in the phone once Meta finally discloses it', async () => {
    h.state.contactByWaUserId = {
      id: 'contact-bsuid',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'realsheenanelson',
    };

    await runWebhook(
      {
        ...USERNAME_ONLY_MESSAGE,
        id: 'wamid.BSUID3',
        from: '16505551234',
      },
      USERNAME_ONLY_CONTACTS
    );

    expect(h.state.contactUpdates).toHaveLength(1);
    expect(h.state.contactUpdates[0]).toMatchObject({ phone: '16505551234' });
  });

  it('drops a delivery that carries neither key rather than inventing a contact', async () => {
    mockFindExistingContact.mockResolvedValue(null);

    const res = await runWebhook(
      {
        id: 'wamid.ANON',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'who am i' },
      },
      [{ profile: { name: 'Nobody' } }]
    );

    expect(h.state.contactInserts).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(0);
    // Still a 200 — Meta must not be told to retry a payload we can
    // never process.
    expect(
      (res as unknown as { init?: { status?: number } }).init?.status
    ).toBe(200);
  });

  it('leaves the legacy phone-only payload behaving exactly as before', async () => {
    await runWebhook();

    expect(mockFindExistingContact).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      '15551230000'
    );
    expect(h.state.contactInserts).toHaveLength(0);
    expect(h.state.contactUpdates).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
  });
});

describe('inbound webhook: contact name backfill (#519 regression guard)', () => {
  it('never overwrites an edited name with the phone number', async () => {
    // Meta sends no profile name. The display fallback would resolve to
    // the phone number, and writing that back would replace whatever an
    // agent typed on the contact — on every single inbound message.
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Ada (VIP, calls Mondays)',
      phone: '15551230000',
    });

    await runWebhook(TEXT_MESSAGE, [{ wa_id: '15551230000', profile: {} }]);

    expect(h.state.contactUpdates).toHaveLength(0);
  });

  it('does adopt a username when that is all Meta gives us', async () => {
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: '15551230000',
      phone: '15551230000',
    });

    await runWebhook(TEXT_MESSAGE, [
      { wa_id: '15551230000', profile: { username: 'ada' } },
    ]);

    expect(h.state.contactUpdates[0]).toMatchObject({ name: 'ada' });
  });
});

describe('template-lifecycle webhooks: WABA id is threaded to the handler (#534)', () => {
  it('passes entry.id as wabaId so an unknown template can be stubbed for the right account', async () => {
    const value = {
      event: 'APPROVED',
      message_template_id: '4242',
      message_template_name: 'created_in_meta',
      message_template_language: 'en_US',
    };
    const body = {
      entry: [
        {
          id: 'WABA-1',
          changes: [{ field: 'message_template_status_update', value }],
        },
      ],
    };
    const req = new Request('https://crm.test/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'x-hub-signature-256': 'sha256=stub' },
    });

    await POST(req);
    for (const cb of h.state.afterCallbacks) await cb();

    const mockHandle = vi.mocked(handleTemplateWebhookChange);
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(mockHandle.mock.calls[0][0]).toEqual({
      field: 'message_template_status_update',
      value,
      wabaId: 'WABA-1',
    });
    // A template event must not fall through to the messaging branch.
    expect(h.state.upsertCalls).toHaveLength(0);
  });
});

describe("status webhook: failed statuses keep Meta's reason (#535)", () => {
  const FAILED_STATUS = {
    id: 'wamid.OUT1',
    status: 'failed',
    timestamp: '1700000100',
    recipient_id: '15551230000',
    errors: [
      {
        code: 131049,
        title:
          'This message was not delivered to maintain healthy ecosystem engagement.',
        message:
          'This message was not delivered to maintain healthy ecosystem engagement.',
        error_data: {
          details:
            'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
        },
        href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
      },
    ],
  };

  it('persists code, title and details on the messages row in the same update as status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runStatusWebhook(FAILED_STATUS);
    } finally {
      warn.mockRestore();
    }

    expect(h.state.messageUpdates).toHaveLength(1);
    expect(h.state.messageUpdates[0]).toEqual({
      status: 'failed',
      error_code: 131049,
      error_title: FAILED_STATUS.errors[0].title,
      error_details: FAILED_STATUS.errors[0].error_data.details,
    });
  });

  it('logs one warning line carrying the wamid, code and title', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runStatusWebhook(FAILED_STATUS);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('wamid.OUT1');
      expect(line).toContain('131049');
      expect(line).toContain(FAILED_STATUS.errors[0].title);
      expect(line).toContain(FAILED_STATUS.errors[0].error_data.details);
    } finally {
      warn.mockRestore();
    }
  });

  it('folds the reason into broadcast_recipients.error_message', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'sent' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runStatusWebhook(FAILED_STATUS);
    } finally {
      warn.mockRestore();
    }

    expect(h.state.recipientUpdates).toHaveLength(1);
    expect(h.state.recipientUpdates[0].status).toBe('failed');
    const reason = String(h.state.recipientUpdates[0].error_message);
    expect(reason).toContain('131049');
    expect(reason).toContain(FAILED_STATUS.errors[0].title);
    expect(reason).toContain(FAILED_STATUS.errors[0].error_data.details);
  });

  it('a failed status with no errors array still flips status and stores no reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runStatusWebhook({ ...FAILED_STATUS, errors: undefined });
    } finally {
      warn.mockRestore();
    }
    expect(warn).not.toHaveBeenCalled();
    expect(h.state.messageUpdates).toEqual([{ status: 'failed' }]);
  });

  it('a plain delivered status updates only status — error columns untouched', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'sent' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runStatusWebhook({
        id: 'wamid.OUT1',
        status: 'delivered',
        timestamp: '1700000100',
        recipient_id: '15551230000',
      });
    } finally {
      warn.mockRestore();
    }

    expect(warn).not.toHaveBeenCalled();
    expect(h.state.messageUpdates).toEqual([{ status: 'delivered' }]);
    expect(h.state.recipientUpdates).toHaveLength(1);
    expect(h.state.recipientUpdates[0]).not.toHaveProperty('error_message');
    expect(h.state.recipientUpdates[0]).not.toHaveProperty('error_code');
  });
});

it('recovers inbox and fan-out after termination following message insertion', async () => {
  const payload = JSON.parse(await inboundRequest().text()) as Parameters<
    typeof processWebhook
  >[0];
  const receipt = { id: 7, lease: 'lease' };
  h.state.failInbox = true;
  await expect(processWebhook(payload, receipt)).rejects.toThrow(
    'inbox_write_failed'
  );
  expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
  h.state.failInbox = false;
  h.state.messageUpsertResult = [];
  h.state.deliveryOwned = true;
  h.state.priorCustomerMsgCount = 1;
  await processWebhook(payload, receipt);
  expect(h.dispatchInboundToFlows).toHaveBeenCalledOnce();
  expect(
    h.runAutomationsForTrigger.mock.calls.map((c) => c[0].triggerType)
  ).toContain('first_inbound_message');
  expect(h.state.upsertCalls[0].row.inbound_delivery_id).toBe(7);
});

it('retains location and late reply context when historical content becomes live inbound', async () => {
  h.state.messageUpsertResult = [];
  h.state.historyPromoted = true;
  await runWebhook({
    ...TEXT_MESSAGE,
    type: 'location',
    location: { latitude: 10, longitude: 76, name: 'Arrival' },
    context: { id: 'unseen-parent' },
  });
  expect(h.state.messageUpdates[0]).toMatchObject({
    content_type: 'location',
    coexistence_metadata: {
      context: { id: 'unseen-parent' },
      location: { latitude: 10, longitude: 76, name: 'Arrival' },
    },
  });
  expect(h.dispatchInboundToFlows).toHaveBeenCalledOnce();
});

it('returns unmatched delivery statuses to durable retry instead of silently completing', async () => {
  h.state.statusResult = { matched: false };
  await expect(
    processWebhook(
      {
        entry: [
          {
            id: 'waba',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    phone_number_id: 'pn-1',
                    display_phone_number: '15551234567',
                  },
                  statuses: [
                    {
                      id: 'early',
                      status: 'delivered',
                      timestamp: '1739230955',
                      recipient_id: '15551234567',
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      { id: 1, lease: 'lease' }
    )
  ).rejects.toThrow('status_unmatched');
  expect(h.dispatchWebhookEvent).not.toHaveBeenCalled();
});
it('fans out the persisted status rather than a late regressive provider status', async () => {
  h.state.statusResult = {
    matched: true,
    account_id: 'acc-1',
    conversation_id: 'conv-1',
    status: 'read',
  };
  await processWebhook(
    {
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: 'pn-1',
                  display_phone_number: '15551234567',
                },
                statuses: [
                  {
                    id: 'late',
                    status: 'sent',
                    timestamp: '1739230955',
                    recipient_id: '15551234567',
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    { id: 1, lease: 'lease' }
  );
  expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
    expect.anything(),
    'acc-1',
    'message.status_updated',
    expect.objectContaining({ status: 'read' })
  );
});

it('accepts a matched broadcast-only status without retrying or emitting an Inbox event', async () => {
  h.state.statusResult = {
    matched: true,
    account_id: 'acc-1',
    conversation_id: null,
    status: 'delivered',
  };
  await expect(
    processWebhook(
      {
        entry: [
          {
            id: 'waba',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    phone_number_id: 'pn-1',
                    display_phone_number: '15551234567',
                  },
                  statuses: [
                    {
                      id: 'broadcast-only',
                      status: 'delivered',
                      timestamp: '1739230955',
                      recipient_id: '15557654321',
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      { id: 1, lease: 'lease' }
    )
  ).resolves.toBeUndefined();
  expect(h.state.rpcCalls).toContainEqual({
    name: 'apply_whatsapp_status',
    args: expect.objectContaining({ p_phone: 'pn-1', p_waba: 'waba' }),
  });
  expect(h.dispatchWebhookEvent).not.toHaveBeenCalled();
});
