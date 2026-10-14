import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ownedChatMediaPath,
  cleanupConversationMedia,
  cleanupDeletedConversationUploads,
} from './delete-conversation';
const base = 'https://project.supabase.co';
const url = `${base}/storage/v1/object/public/chat-media/account-a/inbound/photo.jpg`;
function db(
  result: unknown = false,
  error: unknown = null,
  storageError: unknown = null
) {
  const remove = vi.fn(async () => ({ error: storageError }));
  const rpc = vi.fn(async () => ({ data: result, error }));
  return {
    client: {
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient,
    remove,
    rpc,
  };
}
describe('chat attachment cleanup', () => {
  it('restricts deletion to this project, account and chat bucket', () => {
    expect(ownedChatMediaPath(url, 'a', base)).toBe(
      'account-a/inbound/photo.jpg'
    );
    for (const unsafe of [
      url.replace(base, 'https://external.test'),
      url.replace('account-a', 'account-b'),
      url.replace('chat-media', 'flow-media'),
      '/api/whatsapp/media/123',
      url.replace('photo.jpg', '%2e%2e/secret'),
    ]) {
      expect(ownedChatMediaPath(unsafe, 'a', base)).toBeNull();
    }
  });
  it('removes exclusive uploads once and skips external media', async () => {
    const { client, remove } = db();
    expect(
      await cleanupConversationMedia(
        client,
        'a',
        [url, url, 'https://external.test/file'],
        base
      )
    ).toEqual([]);
    expect(remove).toHaveBeenCalledExactlyOnceWith([
      'account-a/inbound/photo.jpg',
    ]);
  });
  it('keeps shared uploads', async () => {
    const { client, remove } = db(true);
    expect(await cleanupConversationMedia(client, 'a', [url], base)).toEqual(
      []
    );
    expect(remove).not.toHaveBeenCalled();
  });
  it('fails closed and retains retryable cleanup on errors', async () => {
    for (const fixture of [
      db(null),
      db(false, { message: 'failed' }),
      db(false, null, { message: 'failed' }),
    ]) {
      expect(
        await cleanupConversationMedia(fixture.client, 'a', [url], base)
      ).toEqual([url]);
    }
  });
});

describe('worker attachment cleanup recovery', () => {
  it('bounds batches and retains storage failures for the next worker run', async () => {
    const fixture = db(false, null, { message: 'storage unavailable' });
    const update = vi.fn(() => ({
      eq: () => ({ eq: async () => ({ error: null }) }),
    }));
    const client = {
      ...fixture.client,
      from: vi.fn(() => ({
        select: () => ({
          neq: () => ({
            order: () => ({
              limit: async () => ({
                data: [
                  {
                    conversation_id: 'chat',
                    account_id: 'a',
                    media_urls: [url],
                  },
                ],
                error: null,
              }),
            }),
          }),
        }),
        update,
      })),
    } as unknown as SupabaseClient;
    await cleanupDeletedConversationUploads(client, base, Date.now() + 5000);
    expect(update).toHaveBeenCalledWith({ media_urls: [url] });
    expect(fixture.remove).toHaveBeenCalledOnce();
  });
  it('skips maintenance when the delivery worker used its budget', async () => {
    const fixture = db();
    await cleanupDeletedConversationUploads(
      fixture.client,
      base,
      Date.now() - 1
    );
    expect(fixture.rpc).not.toHaveBeenCalled();
  });
});
