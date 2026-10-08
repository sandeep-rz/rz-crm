'use client';
import { useWhatsAppCapability } from './use-whatsapp-capability';

/** Builder bootstrap consumes the dashboard's account-scoped local snapshot. */
export function useAutomationWhatsAppConnections() {
  const whatsapp = useWhatsAppCapability();
  return whatsapp.loading ? null : whatsapp.connections;
}
