'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { useAuth } from '@/hooks/use-auth';
import type { WhatsAppCapabilityPayload } from '@/lib/whatsapp/capability';

export type WhatsAppCapabilityStatus =
  'loading' | 'available' | 'unavailable' | 'error';

export interface WhatsAppCapability {
  status: WhatsAppCapabilityStatus;
  available: boolean;
  connectionCount: number;
  error: string | null;
  refresh: () => void;
}

interface StoredCapability extends WhatsAppCapabilityPayload {
  accountId: string | null;
  status: WhatsAppCapabilityStatus;
  error: string | null;
}

const CapabilityContext = createContext<WhatsAppCapability | null>(null);

export function WhatsAppCapabilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { accountId } = useAuth();
  const [revision, setRevision] = useState(0);
  const [stored, setStored] = useState<StoredCapability>({
    accountId: null,
    status: 'loading',
    available: false,
    connectionCount: 0,
    error: null,
  });

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();

    void fetch('/api/whatsapp/capability', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as Partial<
          WhatsAppCapabilityPayload & { error: string }
        >;
        if (!response.ok) {
          throw new Error(body.error || 'Failed to load WhatsApp capability');
        }
        const available = body.available === true;
        setStored({
          accountId,
          status: available ? 'available' : 'unavailable',
          available,
          connectionCount:
            typeof body.connectionCount === 'number' ? body.connectionCount : 0,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStored({
          accountId,
          status: 'error',
          available: false,
          connectionCount: 0,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to load WhatsApp capability',
        });
      });

    return () => controller.abort();
  }, [accountId, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const current = stored.accountId === accountId && accountId !== null;
  const value = useMemo<WhatsAppCapability>(
    () => ({
      status: current ? stored.status : 'loading',
      available: current ? stored.available : false,
      connectionCount: current ? stored.connectionCount : 0,
      error: current ? stored.error : null,
      refresh,
    }),
    [current, refresh, stored]
  );

  return (
    <CapabilityContext.Provider value={value}>
      {children}
    </CapabilityContext.Provider>
  );
}

export function useWhatsAppCapability(): WhatsAppCapability {
  const capability = useContext(CapabilityContext);
  if (!capability) {
    throw new Error(
      'useWhatsAppCapability must be used inside WhatsAppCapabilityProvider'
    );
  }
  return capability;
}
