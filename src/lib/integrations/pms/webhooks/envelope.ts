const MAX_IDENTIFIER_LENGTH = 255;
const MAX_EVENT_TYPE_LENGTH = 100;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_API_VERSION_LENGTH = 50;
const MAX_RESOURCE_TYPE_LENGTH = 100;

export const SUPPORTED_RZ_PMS_EVENTS = [
  'reservation.confirmed',
  'reservation.updated',
  'reservation.cancelled',
] as const;

export type SupportedRzPmsEvent = (typeof SUPPORTED_RZ_PMS_EVENTS)[number];

export interface RzPmsWebhookEnvelope {
  id: string;
  type: string;
  api_version: string;
  occurred_at: string;
  property_id: string;
  resource: {
    type: string;
    id: string;
  };
  source: {
    type: string;
    id: string;
  } | null;
  data: Record<string, unknown>;
}

export type EnvelopeValidationResult =
  { success: true; data: RzPmsWebhookEnvelope } | { success: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function propertyIdentifier(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  return requiredString(value, MAX_IDENTIFIER_LENGTH);
}

function typedResource(value: unknown): { type: string; id: string } | null {
  if (!isRecord(value)) return null;
  const type = requiredString(value.type, MAX_RESOURCE_TYPE_LENGTH);
  const id = requiredString(value.id, MAX_IDENTIFIER_LENGTH);
  return type && id ? { type, id } : null;
}

export function validateRzPmsWebhookEnvelope(
  value: unknown
): EnvelopeValidationResult {
  if (!isRecord(value)) return { success: false };

  const id = requiredString(value.id, MAX_IDENTIFIER_LENGTH);
  const type = requiredString(value.type, MAX_EVENT_TYPE_LENGTH);
  const apiVersion = requiredString(value.api_version, MAX_API_VERSION_LENGTH);
  const occurredAt = requiredString(value.occurred_at, MAX_TIMESTAMP_LENGTH);
  const propertyId = propertyIdentifier(value.property_id);
  const resource = typedResource(value.resource);
  const source = value.source === null ? null : typedResource(value.source);

  if (
    !id ||
    !type ||
    !apiVersion ||
    !occurredAt ||
    !propertyId ||
    !resource ||
    (value.source !== null && !source) ||
    !isRecord(value.data)
  ) {
    return { success: false };
  }

  if (type.startsWith('reservation.') && resource.type !== 'reservation') {
    return { success: false };
  }

  const occurredAtMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredAtMs)) return { success: false };

  return {
    success: true,
    data: {
      id,
      type,
      api_version: apiVersion,
      occurred_at: new Date(occurredAtMs).toISOString(),
      property_id: propertyId,
      resource,
      source,
      data: value.data,
    },
  };
}

export function isSupportedRzPmsEvent(
  eventType: string
): eventType is SupportedRzPmsEvent {
  return (SUPPORTED_RZ_PMS_EVENTS as readonly string[]).includes(eventType);
}
