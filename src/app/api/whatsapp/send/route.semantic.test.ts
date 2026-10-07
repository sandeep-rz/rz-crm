import { beforeEach, expect, it, vi } from 'vitest';
import { TemplatePreparationError } from '@/lib/message-preparation/errors';
const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/whatsapp/send-message', async (original) => ({
  ...(await original<object>()),
  sendMessageToConversation: h.send,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'workspace',
    userId: 'host',
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'conversation' },
                error: null,
              }),
            }),
          }),
        }),
      }),
    },
  }),
  toErrorResponse: () =>
    Response.json({ error: 'Request failed' }, { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  RATE_LIMITS: { send: {} },
  rateLimitResponse: vi.fn(),
}));
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { POST } from './route';
const templateId = '00000000-0000-4000-8000-000000000004';
const reservationId = '00000000-0000-4000-8000-000000000003';
const request = (extra: object = {}) =>
  new Request('http://localhost/api/whatsapp/send', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: 'conversation',
      message_type: 'template',
      template_id: templateId,
      reservation_id: reservationId,
      ...extra,
    }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.send.mockResolvedValue({
    messageId: 'message',
    whatsappMessageId: 'wamid',
    contentText: 'Real booking values',
  });
});
it('passes trusted active account and selected context to the existing sender, returning persisted text', async () => {
  const response = await POST(request({ account_id: 'FORGED WORKSPACE' }));
  expect(response.status).toBe(200);
  expect(h.send).toHaveBeenCalledWith(
    expect.anything(),
    'workspace',
    expect.objectContaining({
      conversationId: 'conversation',
      messageType: 'template',
    }),
    { templateId, reservationId }
  );
  expect((await response.json()).content_text).toBe('Real booking values');
});
it('invalid selection is rejected before conversation sending', async () => {
  expect((await POST(request({ reservation_id: 'invalid' }))).status).toBe(400);
  expect(h.send).not.toHaveBeenCalled();
});
it('missing required context returns a useful message without diagnostics', async () => {
  h.send.mockRejectedValue(
    new TemplatePreparationError('runtime_resolution_failure', {
      runtimeFailures: [
        {
          code: 'reservation_context_required',
          source: 'context',
          variableKeys: ['PRIVATE VARIABLE PATH'],
          retryable: false,
        },
      ],
    })
  );
  const response = await POST(request({ reservation_id: undefined }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe(
    'Select a reservation before sending this template.'
  );
});
it.each([
  'variable_missing',
  'variable_unsupported',
  'runtime_provider_failure',
] as const)('maps %s without exposing provider paths', async (code) => {
  h.send.mockRejectedValue(
    new TemplatePreparationError(code, { variableKey: 'PRIVATE PROVIDER PATH' })
  );
  const response = await POST(request());
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toBe(
    'Some required contact or reservation information is unavailable.'
  );
  expect(JSON.stringify(body)).not.toContain('PRIVATE');
  expect(body.diagnostics).toBeUndefined();
});
it('invalid semantic configuration has a useful safe error', async () => {
  h.send.mockRejectedValue(
    new TemplatePreparationError('invalid_semantic_mapping')
  );
  const response = await POST(request());
  expect((await response.json()).error).toBe(
    'This template is not ready to send.'
  );
});
it('does not return raw Meta errors', async () => {
  h.send.mockRejectedValue(
    new SendMessageError('meta_error', 'PRIVATE META PAYLOAD ACCESS_TOKEN', 502)
  );
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect((await response.json()).error).toBe(
    'WhatsApp could not send this template.'
  );
});
it('persistence failure avoids encouraging a duplicate send and hides raw SQL', async () => {
  h.send.mockRejectedValue(
    new SendMessageError('db_error', 'PRIVATE SQL', 500)
  );
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect((await response.json()).error).toBe(
    'WhatsApp accepted this template, but it could not be saved. Check the conversation before sending again.'
  );
});
