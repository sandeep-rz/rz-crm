'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from '@/hooks/use-auth';
import type {
  WhatsAppLocalConfig,
  WhatsAppConnectionSummary,
} from '@/lib/whatsapp/config-state';

export type WhatsAppCapabilityStatus =
  'loading' | 'available' | 'unavailable' | 'error';
export interface WhatsAppCapability {
  status: WhatsAppCapabilityStatus;
  available: boolean;
  connectionCount: number;
  configured: boolean;
  connections: WhatsAppConnectionSummary[];
  primaryConnection: WhatsAppConnectionSummary | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<WhatsAppLocalConfig | null>;
  invalidate: () => Promise<WhatsAppLocalConfig | null>;
}
const CapabilityContext = createContext<WhatsAppCapability | null>(null);
const emptyConnections: WhatsAppConnectionSummary[] = [];

/** One dashboard-owned request and snapshot, shared by every navigation consumer. */
export function WhatsAppCapabilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { accountId, user } = useAuth();
  const key = accountId && user?.id ? `${user.id}:${accountId}` : null;
  const activeKey = useRef(key);
  activeKey.current = key;
  const [stored, setStored] = useState<{
    key: string;
    data: WhatsAppLocalConfig | null;
    error: string | null;
    refreshing: boolean;
  } | null>(null);
  const inFlight = useRef<{
    key: string;
    promise: Promise<WhatsAppLocalConfig | null>;
  } | null>(null);
  const lastLoaded = useRef(0);

  const refresh = useCallback((): Promise<WhatsAppLocalConfig | null> => {
    if (!key || activeKey.current !== key) return Promise.resolve(null);
    if (inFlight.current?.key === key) return inFlight.current.promise;
    setStored((old) => ({
      key,
      data: old?.key === key ? old.data : null,
      error: null,
      refreshing: true,
    }));
    const promise = (async () => {
      try {
        const response = await fetch('/api/whatsapp/config', {
          cache: 'no-store',
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.error || 'Failed to load WhatsApp configuration'
          );
        // The server resolves its active account independently. Discard a raced workspace response.
        if (body.account_id !== accountId || !Array.isArray(body.connections)) {
          if (activeKey.current === key)
            setStored({
              key,
              data: null,
              error: 'WhatsApp workspace changed. Retry loading configuration.',
              refreshing: false,
            });
          throw new Error(
            'WhatsApp workspace changed. Retry loading configuration.'
          );
        }
        if (activeKey.current !== key) return null;
        lastLoaded.current = Date.now();
        setStored({ key, data: body, error: null, refreshing: false });
        return body as WhatsAppLocalConfig;
      } catch {
        if (activeKey.current === key)
          setStored((old) => ({
            key,
            data: old?.key === key ? old.data : null,
            error: 'Could not load WhatsApp configuration. Please retry.',
            refreshing: false,
          }));
        return null;
      }
    })();
    inFlight.current = { key, promise };
    void promise.then(() => {
      if (inFlight.current?.promise === promise) inFlight.current = null;
    });
    return promise;
  }, [key, accountId]);

  const invalidate = useCallback(async () => {
    // A GET already underway may predate the successful mutation. Finish it,
    // then read again rather than treating that old response as revalidation.
    if (inFlight.current?.key === key) await inFlight.current.promise;
    return refresh();
  }, [key, refresh]);

  useEffect(() => {
    if (!key) {
      setStored(null);
      return;
    }
    void refresh();
    const onFocus = () => {
      if (Date.now() - lastLoaded.current > 60_000) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [key, refresh]);

  const current = stored?.key === key && key ? stored : null;
  const value = useMemo<WhatsAppCapability>(() => {
    const connections = current?.data?.connections ?? emptyConnections;
    const connectionCount = connections.filter(
      (row) => row.status === 'connected' && Boolean(row.phone_number_id)
    ).length;
    const available = connectionCount > 0;
    return {
      status: current?.data
        ? available
          ? 'available'
          : 'unavailable'
        : current?.error
          ? 'error'
          : 'loading',
      available,
      connectionCount,
      configured: connections.length > 0,
      connections,
      primaryConnection:
        connections.find((row) => row.is_primary) ??
        (connections.length === 1 ? connections[0] : null),
      loading: !current?.data && !current?.error,
      refreshing: current?.refreshing ?? false,
      error: current?.error ?? null,
      refresh,
      invalidate,
    };
  }, [current, refresh, invalidate]);
  return (
    <CapabilityContext.Provider value={value}>
      {children}
    </CapabilityContext.Provider>
  );
}

export function useWhatsAppCapability(): WhatsAppCapability {
  const capability = useContext(CapabilityContext);
  if (!capability)
    throw new Error(
      'useWhatsAppCapability must be used inside WhatsAppCapabilityProvider'
    );
  return capability;
}
