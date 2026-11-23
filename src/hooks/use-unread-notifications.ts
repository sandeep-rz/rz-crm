'use client';

import {
  readNotificationCount,
  useNotificationQuery,
} from './use-notification-query';

/** Authoritative recipient count for the selected workspace. */
export function useUnreadNotifications(): number {
  return useNotificationQuery(readNotificationCount).data ?? 0;
}
