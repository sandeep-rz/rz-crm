'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedSignupAttempt } from '@/lib/whatsapp/embedded-signup-context';

/** Settings-only discovery; the shared connection capability remains authoritative. */
export function useSavedWhatsAppSignups(
  userId: string | undefined,
  accountId: string | null,
  enabled: boolean
) {
  const key = enabled && userId && accountId ? `${userId}:${accountId}` : null;
  const current = useRef(key);
  current.current = key;
  const generation = useRef(0);
  const [saved, setSaved] = useState<{
    key: string;
    attempts: SavedSignupAttempt[];
  } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null
  );
  const refresh = useCallback(async () => {
    if (!key) return;
    const request = ++generation.current;
    try {
      const response = await fetch('/api/whatsapp/embedded-signup', {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || 'Could not load saved setups.');
      if (current.current !== key || generation.current !== request) return;
      if (data.account_id !== accountId)
        throw new Error('Workspace changed. Reload saved setups.');
      setSaved({ key, attempts: data.attempts });
      setError(null);
    } catch (e) {
      if (current.current === key && generation.current === request) {
        setSaved(null);
        setError({
          key,
          message:
            e instanceof Error ? e.message : 'Could not load saved setups.',
        });
      }
    }
  }, [key, accountId]);
  const invalidatePendingRequests = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    void refresh();
    return invalidatePendingRequests;
  }, [refresh, invalidatePendingRequests]);
  return {
    attempts: key && saved?.key === key ? saved.attempts : [],
    error: key && error?.key === key ? error.message : '',
    refresh,
  };
}
