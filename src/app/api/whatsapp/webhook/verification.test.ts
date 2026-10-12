import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
import { encrypt } from '@/lib/whatsapp/encryption';
const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => ({ select: h.read }) }),
}));
vi.mock('@/lib/whatsapp/webhook-runtime', () => ({
  captureWhatsAppDelivery: vi.fn(),
  runWhatsAppWorker: vi.fn(),
}));
const request = (token: string) =>
  new Request(
    `https://crm.test/api/whatsapp/webhook?${new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.challenge': 'challenge', 'hub.verify_token': token })}`
  );
beforeEach(() => {
  vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'shared-verification-token');
  h.read
    .mockReset()
    .mockResolvedValue({
      data: [{ id: 'legacy', verify_token: encrypt('legacy-token') }],
      error: null,
    });
});
it('verifies the provider app before any customer connection exists', async () => {
  const response = await GET(request('shared-verification-token'));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('challenge');
  expect(h.read).not.toHaveBeenCalled();
});
it('preserves encrypted legacy manual tokens and rejects unrelated tokens', async () => {
  expect((await GET(request('legacy-token'))).status).toBe(200);
  expect((await GET(request('wrong'))).status).toBe(403);
});
