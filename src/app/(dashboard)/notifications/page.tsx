'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import {
  readNotifications,
  useNotificationQuery,
} from '@/hooks/use-notification-query';
import type { Notification } from '@/types';
import { Bell, CheckCheck, Loader2, UserPlus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

// Icon per notification type. Only one type exists today
// (conversation_assigned) but this keeps future types a one-line add.
const TYPE_ICON: Record<Notification['type'], typeof Bell> = {
  conversation_assigned: UserPlus,
};

export default function NotificationsPage() {
  const t = useTranslations('Notifications');
  const router = useRouter();
  const {
    data: notifications,
    error,
    refresh: load,
    update,
    isCurrent,
    scope,
    accountId,
    userId,
  } = useNotificationQuery(readNotifications);
  const [markingScope, setMarkingScope] = useState<string | null>(null);
  const markingAll = scope !== null && markingScope === scope;

  const markRead = useCallback(
    async (id: string) => {
      if (!accountId || !userId || !isCurrent()) return;
      // Optimistic — the row is already visually "read" by the time the
      // request lands, so the UI doesn't wait on the round-trip.
      update((rows) =>
        rows.map((n) =>
          n.id === id && !n.read_at
            ? { ...n, read_at: new Date().toISOString() }
            : n
        )
      );
      try {
        const { error: updateError } = await createClient()
          .from('notifications')
          .update({ read_at: new Date().toISOString() })
          .eq('id', id)
          .eq('account_id', accountId)
          .eq('user_id', userId)
          .is('read_at', null);
        if (isCurrent() && updateError) toast.error(t('markReadFailed'));
      } catch {
        if (isCurrent()) toast.error(t('markReadFailed'));
      } finally {
        load();
      }
    },
    [load, t, accountId, userId, isCurrent, update]
  );

  const handleClick = useCallback(
    (n: Notification) => {
      if (!n.read_at) markRead(n.id);
      if (n.conversation_id) {
        router.push(`/inbox?c=${n.conversation_id}`);
      }
    },
    [markRead, router]
  );

  const unreadIds =
    notifications?.filter((n) => !n.read_at).map((n) => n.id) ?? [];

  const markAllRead = useCallback(async () => {
    if (
      !unreadIds.length ||
      !accountId ||
      !userId ||
      !scope ||
      !isCurrent() ||
      markingAll
    )
      return;
    setMarkingScope(scope);
    const now = new Date().toISOString();
    update((rows) => rows.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    try {
      const { error: updateError } = await createClient()
        .from('notifications')
        .update({ read_at: now })
        .eq('account_id', accountId)
        .eq('user_id', userId)
        .is('read_at', null);
      if (!isCurrent()) return;
      if (updateError) toast.error(t('markAllFailed'));
    } catch {
      if (isCurrent()) toast.error(t('markAllFailed'));
    } finally {
      setMarkingScope((current) => (current === scope ? null : current));
      load();
    }
  }, [
    unreadIds.length,
    accountId,
    userId,
    scope,
    isCurrent,
    markingAll,
    update,
    load,
    t,
  ]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-destructive text-sm">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  if (notifications === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unreadIds.length === 0 || markingAll}
          onClick={markAllRead}
        >
          {markingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="h-4 w-4" />
          )}
          {t('markAllRead')}
        </Button>
      </div>

      {notifications.length === 0 ? (
        <div className="border-border bg-muted/40 flex h-48 flex-col items-center justify-center rounded-xl border border-dashed">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-xl">
            <Bell className="text-primary h-6 w-6" />
          </div>
          <p className="text-foreground mt-3 text-sm font-medium">
            {t('emptyTitle')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">{t('emptyDesc')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => {
            const Icon = TYPE_ICON[n.type] ?? Bell;
            const isUnread = !n.read_at;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => handleClick(n)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                    isUnread
                      ? 'border-primary/30 bg-primary/5 hover:border-primary/50'
                      : 'border-border bg-card hover:border-border/70'
                  )}
                >
                  <div
                    className={cn(
                      'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg',
                      isUnread ? 'bg-primary/15' : 'bg-muted'
                    )}
                    aria-hidden
                  >
                    <Icon
                      className={cn(
                        'h-5 w-5',
                        isUnread ? 'text-primary' : 'text-muted-foreground'
                      )}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'truncate text-sm font-semibold',
                          isUnread ? 'text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        {n.title}
                      </span>
                      {isUnread && (
                        <span
                          aria-label={t('unread')}
                          className="bg-primary h-2 w-2 flex-shrink-0 rounded-full"
                        />
                      )}
                    </div>
                    {n.body && (
                      <p className="text-muted-foreground mt-0.5 truncate text-xs">
                        {n.body}
                      </p>
                    )}
                    <p className="text-muted-foreground/70 mt-1 text-[11px]">
                      {formatDistanceToNow(new Date(n.created_at), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
