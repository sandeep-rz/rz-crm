import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from './route';
const h = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/whatsapp/webhook-runtime', () => ({ runWhatsAppWorker: h.run }));
const token = 'a'.repeat(48);
const request = (value?: string) =>
  new Request('https://crm.test/api/whatsapp/webhook/worker', {
    method: 'POST',
    headers: value ? { 'x-whatsapp-worker-token': value } : {},
  });
beforeEach(() => {
  vi.stubEnv('WHATSAPP_WORKER_TOKEN', token);
  h.run.mockReset().mockResolvedValue({ processed: 2, failed: 0 });
});
it('fails closed when worker authentication is missing or misconfigured', async () => {
  expect((await POST(request())).status).toBe(401);
  expect((await POST(request('b'.repeat(48)))).status).toBe(401);
  expect((await POST(request('é'.repeat(48)))).status).toBe(401);
  vi.stubEnv('WHATSAPP_WORKER_TOKEN', 'short');
  expect((await POST(request('short'))).status).toBe(503);
  expect(h.run).not.toHaveBeenCalled();
});
it('only runs authenticated work and returns safe failure responses', async () => {
  expect(await (await POST(request(token))).json()).toEqual({
    processed: 2,
    failed: 0,
  });
  h.run.mockRejectedValue(new Error('private token and message content'));
  const response = await POST(request(token));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private');
});
