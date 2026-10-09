import { beforeEach, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encrypt } from './encryption';
import { resumeCoexistenceSync } from './coexistence-sync';
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./embedded-signup', () => ({ requestCoexistenceSync: h.request }));
const intents = new Set<string>();
let configOverrides: Record<string, unknown> = {};
let saveError = false;
const rpc = vi.fn(async (name: string, args: Record<string, string>) => {
  if (name === 'begin_whatsapp_coexistence_sync') {
    if (intents.has(args.p_type)) return { data: false, error: null };
    intents.add(args.p_type);
    return { data: true, error: null };
  }
  return { data: null, error: saveError ? { code: 'XX000' } : null };
});
const db = {
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: {
            id: 'c',
            phone_number_id: '123',
            access_token: encrypt('private-token'),
            status: 'connected',
            onboarding_metadata: { onboarding_mode: 'coexistence' },
            ...configOverrides,
          },
          error: null,
        }),
      }),
    }),
  }),
  rpc,
} as unknown as SupabaseClient;
beforeEach(() => {
  intents.clear();
  configOverrides = {};
  saveError = false;
  rpc.mockClear();
  h.request.mockReset().mockResolvedValue('request-id');
});
it('commits distinct one-time contact/history intents before making Meta requests', async () => {
  h.request.mockImplementation(async (_phone, _token, type) => {
    expect(intents.has(type)).toBe(true);
    return 'request-id';
  });
  await resumeCoexistenceSync(db, 'c');
  expect(h.request.mock.calls.map((c) => c[2])).toEqual([
    'smb_app_state_sync',
    'history',
  ]);
  expect(
    rpc.mock.calls.filter((c) => c[0] === 'accept_whatsapp_coexistence_sync')
  ).toHaveLength(2);
});
it('duplicate callbacks and reconnects never repeat accepted sync calls', async () => {
  await resumeCoexistenceSync(db, 'c');
  await resumeCoexistenceSync(db, 'c');
  expect(h.request).toHaveBeenCalledTimes(2);
});
it('timeout recovery does not repeat one-time requests with unknown outcomes', async () => {
  h.request.mockRejectedValue(new Error('transport timeout private-token'));
  await resumeCoexistenceSync(db, 'c');
  await resumeCoexistenceSync(db, 'c');
  expect(h.request).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls.some((c) => /reset/i.test(c[0]))).toBe(false);
});
it('local decryption or identity failures reserve nothing and can be recovered safely', async () => {
  for (const invalid of [
    { access_token: 'broken' },
    { access_token: encrypt('') },
    { phone_number_id: 'invalid' },
  ]) {
    configOverrides = invalid;
    await expect(resumeCoexistenceSync(db, 'c')).rejects.toThrow(
      'No synchronization request was reserved'
    );
    expect(rpc).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  }
  configOverrides = {};
  expect(await resumeCoexistenceSync(db, 'c')).toBe(true);
  expect(h.request).toHaveBeenCalledTimes(2);
});
it('acceptance persistence failure reports pending sync without repeating Meta requests', async () => {
  saveError = true;
  expect(await resumeCoexistenceSync(db, 'c')).toBe(false);
  await resumeCoexistenceSync(db, 'c');
  expect(h.request).toHaveBeenCalledTimes(2);
});
it('keeps a saved unconfirmed outcome pending without resending it', async () => {
  intents.add('history');
  configOverrides = {
    coexistence_state: { history: { state: 'unconfirmed' } },
  };
  expect(await resumeCoexistenceSync(db, 'c')).toBe(false);
  expect(h.request.mock.calls.map((call) => call[2])).toEqual([
    'smb_app_state_sync',
  ]);
});
