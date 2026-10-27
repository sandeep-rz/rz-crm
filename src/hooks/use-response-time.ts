'use client';

import { useEffect, useState } from 'react';
import { useAuth } from './use-auth';
import { createClient } from '@/lib/supabase/client';
import { loadResponseTime } from '@/lib/dashboard/queries';
import type { ResponseTimeSummary } from '@/lib/dashboard/types';

/** Scope results to the active workspace and preference. Never display a
 * previous workspace's result while a new request is in flight. */
export function useResponseTime() {
  const { accountId, defaultTimezone, accountStatus } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([
    accountId,
    defaultTimezone,
    accountStatus,
    attempt,
  ]);
  const [result, setResult] = useState<{
    scope: string;
    data: ResponseTimeSummary | null;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    if (!accountId || accountStatus !== 'ready') return;
    let active = true;
    void loadResponseTime(createClient(), accountId).then(
      (data) => {
        if (active) setResult({ scope, data, error: false });
      },
      () => {
        if (active) setResult({ scope, data: null, error: true });
      }
    );
    return () => {
      active = false;
    };
  }, [accountId, accountStatus, scope]);
  const current = result?.scope === scope ? result : null;
  return {
    data: current?.data ?? null,
    loading: !current,
    error: current?.error ?? false,
    retry: () => setAttempt((value) => value + 1),
  };
}
