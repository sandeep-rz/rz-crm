'use client';
import { useEffect, useState } from 'react';
import type { WhatsAppConnectionOption } from '@/components/automations/automation-builder';

/** New/edit page bootstrap. Menus only consume the loaded result; no global/account cache. */
export function useAutomationWhatsAppConnections() {
  const [connections, setConnections] = useState<
    WhatsAppConnectionOption[] | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    fetch('/api/whatsapp/config', { signal: controller.signal })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled)
          setConnections(
            Array.isArray(body?.connections) ? body.connections : []
          );
      })
      .catch(() => {
        if (!cancelled) setConnections([]);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);
  return connections;
}
