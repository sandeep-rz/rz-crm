/** Validated URL capability outcomes used by the PMS provider adapter. */
export type IntegrationCapabilityKey =
  | 'reservation.digital_checkin_url'
  | 'reservation.review_destination_url'
  | 'reservation.review_url';
export type CapabilityAvailability =
  'available' | 'feature_disabled' | 'not_ready' | 'expired' | 'unavailable';

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
  capability:
    | 'reservation.digital_checkin_url'
    | 'reservation.review_url'
    | 'reservation.review_destination_url',
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
