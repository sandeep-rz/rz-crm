import type { SupabaseClient } from '@supabase/supabase-js';

/** Only local, account-owned chat uploads can be removed. Never touch Meta or external URLs. */
export function ownedChatMediaPath(
  url: string,
  accountId: string,
  supabaseUrl: string
): string | null {
  try {
    if (
      decodeURIComponent(url)
        .split(/[/?#]/)
        .some((part) => part === '..' || part === '.')
    )
      return null;
    const parsed = new URL(url);
    const base = new URL(supabaseUrl);
    const prefix = '/storage/v1/object/public/chat-media/';
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith(prefix))
      return null;
    const path = decodeURIComponent(parsed.pathname.slice(prefix.length));
    // Encoded/legacy names have ambiguous URL aliases; retain them conservatively.
    if (!/^[a-zA-Z0-9_./-]+$/.test(path)) return null;
    if (
      !path.startsWith(`account-${accountId}/`) ||
      path.split('/').some((part) => part === '..' || part === '.')
    )
      return null;
    return path;
  } catch {
    return null;
  }
}

export async function cleanupConversationMedia(
  db: SupabaseClient,
  accountId: string,
  urls: string[],
  supabaseUrl: string
): Promise<string[]> {
  const failed: string[] = [];
  for (const url of new Set(urls)) {
    const path = ownedChatMediaPath(url, accountId, supabaseUrl);
    if (!path) continue;
    const { data: referenced, error } = await db.rpc(
      'conversation_media_is_referenced',
      { p_url: url, p_path: path }
    );
    // Fail closed when reference checking is unavailable or ambiguous.
    if (error || typeof referenced !== 'boolean') {
      failed.push(url);
      continue;
    }
    if (referenced) continue;
    const { error: removeError } = await db.storage
      .from('chat-media')
      .remove([path]);
    if (removeError) failed.push(url);
  }
  return failed;
}

/** Reuse the existing authenticated WhatsApp worker for bounded Storage retries. */
export async function cleanupDeletedConversationUploads(
  db: SupabaseClient,
  supabaseUrl: string,
  deadline: number
): Promise<void> {
  if (Date.now() >= deadline) return;
  const { data, error } = await db
    .from('conversation_deletions')
    .select('conversation_id,account_id,media_urls')
    .neq('media_urls', '{}')
    .order('deleted_at', { ascending: true })
    .limit(3);
  if (error) throw new Error('conversation_media_cleanup_discovery_failed');
  for (const row of data ?? []) {
    if (Date.now() >= deadline) break;
    const failed = await cleanupConversationMedia(
      db,
      row.account_id,
      row.media_urls.slice(0, 5),
      supabaseUrl
    );
    const pending = [...row.media_urls.slice(5), ...failed];
    const { error: saveError } = await db
      .from('conversation_deletions')
      .update({ media_urls: pending })
      .eq('conversation_id', row.conversation_id)
      .eq('account_id', row.account_id);
    if (saveError) throw new Error('conversation_media_cleanup_save_failed');
  }
}
