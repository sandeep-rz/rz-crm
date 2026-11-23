'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { Notification } from '@/types';

type Result<T> = { data: T | null; error: { message: string } | null };
type Query<T> = (
  db: SupabaseClient,
  accountId: string,
  userId: string
) => Promise<Result<T>>;

/** Serialize refreshes: an event during a read invalidates its result and queues
 * another read. Counts never depend on duplicate/partial realtime deltas. */
export function useNotificationQuery<T>(query: Query<T>) {
  const { accountId, user } = useAuth();
  const userId = user?.id;
  const scope = accountId && userId ? `${accountId}:${userId}` : null;
  const [state, setState] = useState<{
    scope: string;
    data: T | null;
    error: string | null;
  } | null>(null);
  const runner = useRef<{ scope: string; refresh: () => void } | null>(null);
  useEffect(() => {
    if (!accountId || !userId || !scope) return;
    const db = createClient();
    let cancelled = false,
      running = false,
      requested = false;
    const refresh = () => {
      if (cancelled) return;
      requested = true;
      if (running) return;
      void drain();
    };
    async function drain() {
      running = true;
      try {
        while (requested && !cancelled) {
          requested = false;
          let result: Result<T>;
          try {
            result = await query(db, accountId!, userId!);
          } catch {
            result = {
              data: null,
              error: { message: 'Could not load notifications.' },
            };
          }
          if (cancelled || requested) continue;
          setState((previous) => ({
            scope: scope!,
            data: result.error
              ? previous?.scope === scope
                ? previous.data
                : null
              : result.data,
            error: result.error?.message ?? null,
          }));
        }
      } finally {
        running = false;
      }
    }
    runner.current = { scope, refresh };
    const changed = (payload: {
      eventType: string;
      new?: Partial<Notification>;
      old?: Partial<Notification>;
    }) => {
      if (cancelled) return;
      const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
      if (row?.account_id && row.account_id !== accountId) return;
      if (row?.user_id && row.user_id !== userId) return;
      // DELETE can contain only the primary key. Refetch the scoped query.
      refresh();
    };
    const channel = db
      .channel(
        `notifications:${scope}:${query === readNotificationCount ? 'count' : 'list'}`
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `account_id=eq.${accountId}`,
        },
        changed
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'notifications' },
        changed
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') refresh();
      });
    refresh();
    return () => {
      cancelled = true;
      if (runner.current?.scope === scope) runner.current = null;
      void db.removeChannel(channel);
    };
  }, [accountId, userId, scope, query]);
  const refresh = useCallback(() => {
    if (runner.current?.scope === scope) runner.current.refresh();
  }, [scope]);
  const isCurrent = useCallback(
    () => scope !== null && runner.current?.scope === scope,
    [scope]
  );
  const update = useCallback(
    (apply: (value: T) => T) => {
      setState((previous) =>
        previous?.scope === scope && previous.data !== null
          ? { ...previous, data: apply(previous.data) }
          : previous
      );
    },
    [scope]
  );
  const current = state?.scope === scope ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    refresh,
    update,
    isCurrent,
    scope,
    accountId,
    userId,
  };
}

export async function readNotificationCount(
  db: SupabaseClient,
  accountId: string,
  userId: string
): Promise<Result<number>> {
  const { count, error } = await db
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('user_id', userId)
    .is('read_at', null);
  return { data: count ?? 0, error };
}
export async function readNotifications(
  db: SupabaseClient,
  accountId: string,
  userId: string
): Promise<Result<Notification[]>> {
  const { data, error } = await db
    .from('notifications')
    .select('*')
    .eq('account_id', accountId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  return { data: data as Notification[] | null, error };
}
