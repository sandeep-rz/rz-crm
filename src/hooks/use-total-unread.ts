'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { Conversation } from '@/types';

/** Count unread conversations, with keyset paging and realtime overlays. */
export function useTotalUnread(): number {
  const { accountId, user } = useAuth();
  const userId = user?.id;
  const scope = accountId && userId ? `${accountId}:${userId}` : null;
  const [state, setState] = useState<{ scope: string; total: number } | null>(
    null
  );
  useEffect(() => {
    if (!accountId || !scope) return;
    const db = createClient();
    const unread = new Set<string>();
    let cancelled = false,
      running = false,
      requested = false;
    let overlay: Map<string, boolean> | null = null;
    const publish = () => {
      if (!cancelled) setState({ scope: scope!, total: unread.size });
    };
    const refresh = () => {
      if (cancelled) return;
      requested = true;
      if (!running) void drain();
    };
    async function drain() {
      running = true;
      try {
        while (requested && !cancelled) {
          requested = false;
          const snapshot = new Set<string>();
          overlay = new Map();
          try {
            let cursor: string | null = null;
            for (;;) {
              let query = db
                .from('conversations')
                .select('id')
                .eq('account_id', accountId!)
                .gt('unread_count', 0)
                .order('id')
                .limit(500);
              if (cursor) query = query.gt('id', cursor);
              const { data, error } = await query;
              if (error) throw error;
              if (cancelled) return;
              if (!data?.length) break;
              for (const row of data) snapshot.add(row.id);
              const last = data[data.length - 1].id as string;
              if (cursor && last <= cursor)
                throw new Error('Unread cursor did not advance');
              cursor = last;
            }
            if (requested) continue;
            for (const [id, isUnread] of overlay) {
              if (isUnread) snapshot.add(id);
              else snapshot.delete(id);
            }
            unread.clear();
            for (const id of snapshot) unread.add(id);
            publish();
          } catch {
            // Keep realtime state on read failure; subscription/reconnect retries.
          } finally {
            overlay = null;
          }
        }
      } finally {
        running = false;
      }
    }
    const changed = (payload: {
      eventType: string;
      new?: Partial<Conversation>;
      old?: Partial<Conversation>;
    }) => {
      if (cancelled) return;
      const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
      if (row?.account_id && row.account_id !== accountId) return;
      if (!row?.id) return;
      if (payload.eventType !== 'DELETE' && row.account_id !== accountId) {
        refresh();
        return;
      }
      if (
        payload.eventType !== 'DELETE' &&
        typeof row.unread_count !== 'number'
      ) {
        refresh();
        return;
      }
      const isUnread =
        payload.eventType !== 'DELETE' && (row.unread_count ?? 0) > 0;
      overlay?.set(row.id, isUnread);
      if (isUnread) unread.add(row.id);
      else unread.delete(row.id);
      publish();
    };
    const channel = db
      .channel(`total-unread:${scope}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversations',
          filter: `account_id=eq.${accountId}`,
        },
        changed
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'conversations' },
        changed
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') refresh();
      });
    refresh();
    return () => {
      cancelled = true;
      void db.removeChannel(channel);
    };
  }, [accountId, userId, scope]);
  return state?.scope === scope ? state.total : 0;
}
