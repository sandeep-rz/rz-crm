/**
 * Provider-neutral integration capability vocabulary (v2 foundation).
 *
 * This is metadata and routing policy, not a provider API client. The trusted
 * server loads binding IDs and permissions from CRM storage. The language model
 * and browser must never provide external host/group IDs or service credentials.
 *
 * Existing /variables/resolve contract_version:v1 remains unchanged.
 */
export const INTEGRATION_CAPABILITIES = {
  'reservation.digital_checkin_url': {
    kind: 'variable',
    scope: 'reservation',
    dataType: 'url',
    requires: ['reservation', 'property'],
  },
  'reservation.review_url': {
    kind: 'variable',
    scope: 'reservation',
    dataType: 'url',
    requires: ['reservation'],
  },
  'reservation.get_details': {
    kind: 'query',
    scope: 'reservation',
    requires: ['reservation'],
  },
  'availability.search': {
    kind: 'query',
    scope: 'integration',
    requires: ['property_scope'],
  },
  'rates.quote': {
    kind: 'query',
    scope: 'integration',
    requires: ['property_scope'],
  },
  'reservation.create': {
    kind: 'action',
    scope: 'integration',
    requires: ['property_scope'],
  },
  'reservation.cancel': {
    kind: 'action',
    scope: 'reservation',
    requires: ['reservation'],
  },
  'review.submitted': {
    kind: 'event',
    scope: 'reservation',
    requires: ['reservation'],
  },
} as const;

export type IntegrationCapabilityKey = keyof typeof INTEGRATION_CAPABILITIES;
export type IntegrationCapabilityKind = 'variable' | 'query' | 'action' | 'event';
export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';
export type CapabilityAvailability =
  | 'available'
  | 'feature_disabled'
  | 'not_ready'
  | 'expired'
  | 'unavailable';

export interface CapabilityDeclaration {
  key: IntegrationCapabilityKey;
  support: CapabilitySupport;
  /** A declaration is provider-level; property eligibility is checked separately. */
  source: 'provider' | 'crm';
}

export type CapabilityValue =
  | { status: 'resolved'; value: string }
  | {
      status: 'missing' | 'unsupported';
      value: null;
      reason?:
        | 'feature_disabled'
        | 'not_ready'
        | 'expired'
        | 'reservation_inactive'
        | 'provider_unsupported';
    };

export type CapabilityResolution =
  | {
      status: 'available';
      value: string;
      capability: IntegrationCapabilityKey;
    }
  | {
      status: 'unavailable';
      capability: IntegrationCapabilityKey;
      reason: Exclude<CapabilityAvailability, 'available'>;
    };

/** Provider responses must not turn an empty URL into a successful variable. */
export function normalizeUrlCapability(
  capability: 'reservation.digital_checkin_url' | 'reservation.review_url',
  input: CapabilityValue
): CapabilityResolution {
  if (input.status === 'resolved') {
    try {
      const parsed = new URL(input.value);
      if (
        !['https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hostname === ''
      ) {
        return { status: 'unavailable', capability, reason: 'unavailable' };
      }
      return { status: 'available', capability, value: input.value };
    } catch {
      return { status: 'unavailable', capability, reason: 'unavailable' };
    }
  }
  const reason: Exclude<CapabilityAvailability, 'available'> =
    input.status === 'unsupported'
      ? 'unavailable'
      : input.reason === 'feature_disabled' ||
          input.reason === 'not_ready' ||
          input.reason === 'expired'
        ? input.reason
        : 'unavailable';
  return { status: 'unavailable', capability, reason };
}

/**
 * Trusted, server-created, per-integration binding. A persisted identity map
 * must establish these IDs; NEVER accept them from an AI tool call.
 */
export interface TrustedIntegrationBinding {
  accountId: string;
  integrationId: string;
  provider: string;
  externalAccountId: string;
  /** CRM property ID -> provider property ID. */
  properties: ReadonlyArray<{
    crmPropertyId: string;
    externalPropertyId: string;
    enabled: boolean;
  }>;
  /** Increment when connection permissions, mappings or credentials change. */
  configVersion: number;
}

export type CapabilityRoute =
  | {
      ok: true;
      accountId: string;
      integrationId: string;
      provider: string;
      externalAccountId: string;
      crmPropertyIds: string[];
      externalPropertyIds: string[];
      configVersion: number;
    }
  | {
      ok: false;
      reason: 'invalid_binding' | 'property_out_of_scope';
    };

/**
 * Picks only trusted, enabled property mappings; the caller never supplies a
 * provider host/group ID. The adapter may translate the externalAccountId to
 * a provider-specific host/group identifier.
 */
export function scopeCapabilityRoute(
  binding: TrustedIntegrationBinding,
  requestedCrmPropertyIds: readonly string[]
): CapabilityRoute {
  if (
    !binding.accountId ||
    !binding.integrationId ||
    !binding.provider ||
    !binding.externalAccountId ||
    !Number.isSafeInteger(binding.configVersion) ||
    binding.configVersion < 1 ||
    !Array.isArray(binding.properties) ||
    !Array.isArray(requestedCrmPropertyIds)
  ) {
    return { ok: false, reason: 'invalid_binding' };
  }
  const mappings = new Map<string, string>();
  for (const property of binding.properties) {
    if (!property.crmPropertyId || !property.externalPropertyId) {
      return { ok: false, reason: 'invalid_binding' };
    }
    if (mappings.has(property.crmPropertyId)) {
      return { ok: false, reason: 'invalid_binding' };
    }
    if (property.enabled) mappings.set(property.crmPropertyId, property.externalPropertyId);
    else mappings.set(property.crmPropertyId, '');
  }
  const requested = [...new Set(requestedCrmPropertyIds)];
  // Empty scope must not accidentally mean "all properties".
  if (!requested.length || requested.some((id) => !mappings.get(id))) {
    return { ok: false, reason: 'property_out_of_scope' };
  }
  return {
    ok: true,
    accountId: binding.accountId,
    integrationId: binding.integrationId,
    provider: binding.provider,
    externalAccountId: binding.externalAccountId,
    crmPropertyIds: requested,
    externalPropertyIds: requested.map((id) => mappings.get(id)!),
    configVersion: binding.configVersion,
  };
}
