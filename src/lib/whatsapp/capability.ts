export interface WhatsAppCapabilityPayload {
  available: boolean;
  connectionCount: number;
}

export function capabilityFromConnectionCount(
  count: number | null | undefined
): WhatsAppCapabilityPayload {
  const connectionCount = Math.max(0, count ?? 0);
  return {
    available: connectionCount > 0,
    connectionCount,
  };
}
