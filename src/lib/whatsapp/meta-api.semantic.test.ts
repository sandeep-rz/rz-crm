import { afterEach, expect, it, vi } from 'vitest';
import { sendTemplateMessage } from './meta-api';
afterEach(() => vi.unstubAllGlobals());
it('existing Meta transport posts assembled semantic components without legacy/sample fallback', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'meta-id' }] }), {
        status: 200,
      })
    );
  vi.stubGlobal('fetch', fetch);
  const templatePayload = {
    name: 'authoritative',
    language: { code: 'en_GB' },
    components: [
      {
        type: 'body' as const,
        parameters: [{ type: 'text' as const, text: '0' }],
      },
    ],
  };
  await sendTemplateMessage({
    phoneNumberId: 'phone',
    accessToken: 'secret',
    to: '919876543210',
    templateName: 'stale',
    language: 'fr',
    params: ['SAMPLE'],
    templatePayload,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.template).toEqual(templatePayload);
  expect(body.messaging_product).toBe('whatsapp');
  expect(body.type).toBe('template');
  expect(JSON.stringify(body)).not.toContain('SAMPLE');
});
