import { beforeEach, expect, it, vi } from 'vitest';
vi.unmock('./send-policy');
const h = vi.hoisted(() => ({ rpc: vi.fn(), fetch: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc: h.rpc }),
}));
import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
} from './meta-api';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', h.fetch);
  h.rpc.mockResolvedValue({ data: 0, error: null });
  h.fetch.mockResolvedValue(
    new Response(JSON.stringify({ messages: [{ id: 'wamid.one' }] }))
  );
});
it.each([35, -1])(
  'rejects locally before HTTP for quota or offboarding allowance=%i',
  async (data) => {
    h.rpc.mockResolvedValue({ data, error: null });
    await expect(
      sendTextMessage({
        phoneNumberId: '456',
        accessToken: 'secret',
        to: '15551234567',
        text: 'hello',
      })
    ).rejects.toMatchObject({ httpStatus: data < 0 ? 409 : 429 });
    expect(h.fetch).not.toHaveBeenCalled();
  }
);
it('fails closed when shared allowance cannot be verified', async () => {
  h.rpc.mockResolvedValue({ data: null, error: { code: 'down' } });
  await expect(
    sendTextMessage({
      phoneNumberId: '456',
      accessToken: 'secret',
      to: '15551234567',
      text: 'hello',
    })
  ).rejects.toMatchObject({ httpStatus: 429 });
  expect(h.fetch).not.toHaveBeenCalled();
});
it('sends only after obtaining the shared allowance', async () => {
  await sendTextMessage({
    phoneNumberId: '456',
    accessToken: 'secret',
    to: '15551234567',
    text: 'hello',
  });
  expect(h.rpc).toHaveBeenCalledWith('acquire_whatsapp_send', {
    p_phone: '456',
  });
  expect(h.rpc.mock.invocationCallOrder[0]).toBeLessThan(
    h.fetch.mock.invocationCallOrder[0]
  );
});

it.each([
  [
    'media',
    () =>
      sendMediaMessage({
        phoneNumberId: '456',
        accessToken: 'secret',
        to: '15551234567',
        kind: 'image',
        link: 'https://example.test/image.jpg',
      }),
  ],
  [
    'template',
    () =>
      sendTemplateMessage({
        phoneNumberId: '456',
        accessToken: 'secret',
        to: '15551234567',
        templateName: 'hello',
      }),
  ],
  [
    'buttons',
    () =>
      sendInteractiveButtons({
        phoneNumberId: '456',
        accessToken: 'secret',
        to: '15551234567',
        bodyText: 'Pick',
        buttons: [{ id: 'yes', title: 'Yes' }],
      }),
  ],
  [
    'list',
    () =>
      sendInteractiveList({
        phoneNumberId: '456',
        accessToken: 'secret',
        to: '15551234567',
        bodyText: 'Pick',
        buttonLabel: 'Choose',
        sections: [{ title: 'Options', rows: [{ id: 'yes', title: 'Yes' }] }],
      }),
  ],
  [
    'reaction',
    () =>
      sendReactionMessage({
        phoneNumberId: '456',
        accessToken: 'secret',
        to: '15551234567',
        targetMessageId: 'wamid.one',
        emoji: '👍',
      }),
  ],
] as const)('guards the %s message path before HTTP', async (_name, send) => {
  h.rpc.mockResolvedValue({ data: -1, error: null });
  await expect(send()).rejects.toMatchObject({ httpStatus: 409 });
  expect(h.fetch).not.toHaveBeenCalled();
});
