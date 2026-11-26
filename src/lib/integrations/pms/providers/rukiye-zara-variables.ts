import 'server-only';
import { PmsHttpClient } from '../http-client';
import { PmsProviderError } from '../provider';
import { normalizeUrlCapability } from '@/lib/integrations/capability-contract';
import type {
  ConnectedSystemVariableResolver,
  ConnectedVariableContext,
  ConnectedVariableValue,
} from '../variable-resolver';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rzVariableContext(context: ConnectedVariableContext) {
  // These are the exact source strings emitted by the canonical reservation API.
  const sourceType =
    context.sourceType === 'bookings'
      ? 'rz_booking'
      : context.sourceType === 'pms_bookings'
        ? 'pms_booking'
        : null;
  if (!sourceType || !uuid.test(context.externalReservationId))
    throw new PmsProviderError(
      'configuration',
      'Reservation source mapping is invalid.'
    );
  return {
    source_type: sourceType,
    source_record_id: context.externalReservationId,
  };
}

export class RukiyeZaraVariableResolver implements ConnectedSystemVariableResolver {
  constructor(private readonly client = new PmsHttpClient()) {}
  async resolveVariables({
    context,
    variableKeys,
  }: Parameters<ConnectedSystemVariableResolver['resolveVariables']>[0]) {
    const keys = [...new Set(variableKeys)];
    if (!keys.length) return {};
    if (keys.length > 100)
      throw new PmsProviderError(
        'configuration',
        'RZ PMS supports at most 100 variables per operation.'
      );
    const source = rzVariableContext(context);
    const v2Keys = keys.filter((key) => V2_LINK_VARIABLES.has(key));
    const v1Keys = keys.filter((key) => !V2_LINK_VARIABLES.has(key));
    const values: Record<string, ConnectedVariableValue> = {};
    // No v2 endpoint is invoked for existing v1 templates. New link variables
    // are gated by inactive catalog entries until the PMS deploys v2.
    if (v2Keys.length) {
      const resolved = await this.resolveLinkCapabilities(context, source, v2Keys);
      Object.assign(values, resolved);
    }
    if (!v1Keys.length) return values;
    const data = await this.client.post<unknown>(
      '/v1/integrations/rz-crm/variables/resolve',
      {
        contract_version: 'v1',
        context: source,
        variables: v1Keys,
      }
    );
    const invalid = () =>
      new PmsProviderError(
        'invalid_response',
        'RZ PMS variable response is invalid.'
      );
    if (
      !object(data) ||
      data.success !== true ||
      data.contract_version !== 'v1' ||
      !object(data.context) ||
      data.context.source_type !== source.source_type ||
      data.context.source_record_id !== source.source_record_id ||
      !object(data.values)
    )
      throw invalid();
    // Whitelist only requested keys; ignore any additional returned values.
    for (const key of v1Keys) {
      if (!Object.hasOwn(data.values, key)) throw invalid();
      const item = data.values[key];
      if (!object(item)) throw invalid();
      if (
        item.status === 'resolved' &&
        typeof item.value === 'string' &&
        item.value.trim()
      )
        values[key] = { status: 'resolved', value: item.value };
      else if (
        (item.status === 'missing' || item.status === 'unsupported') &&
        item.value === null
      )
        values[key] = { status: item.status, value: null };
      else throw invalid();
    }
    return values;
  }

  private async resolveLinkCapabilities(
    context: ConnectedVariableContext,
    source: { source_type: string; source_record_id: string },
    keys: string[]
  ): Promise<Record<string, ConnectedVariableValue>> {
    const data = await this.client.post<unknown>(
      '/v1/integrations/rz-crm/capabilities/resolve',
      {
        contract_version: 'v2',
        context: {
          ...source,
          external_account_id: context.externalAccountId,
          external_property_id: context.externalPropertyId,
        },
        capabilities: keys,
      }
    );
    if (
      !object(data) ||
      data.success !== true ||
      data.contract_version !== 'v2' ||
      !object(data.context) ||
      data.context.source_type !== source.source_type ||
      data.context.source_record_id !== source.source_record_id ||
      data.context.external_account_id !== context.externalAccountId ||
      data.context.external_property_id !== context.externalPropertyId ||
      !object(data.values)
    ) {
      throw new PmsProviderError('invalid_response', 'RZ PMS v2 response is invalid.');
    }
    const results: Record<string, ConnectedVariableValue> = {};
    for (const key of keys) {
      const entry = data.values[key];
      if (!object(entry) || !['resolved', 'missing', 'unsupported'].includes(String(entry.status))) {
        throw new PmsProviderError('invalid_response', 'RZ PMS v2 capability response is invalid.');
      }
      if (entry.status === 'resolved') {
        if (typeof entry.value !== 'string' || !entry.value.trim()) {
          throw new PmsProviderError('invalid_response', 'RZ PMS v2 capability URL is invalid.');
        }
        const validated = normalizeUrlCapability(
          key === 'reservation.digital_checkin_url'
            ? 'reservation.digital_checkin_url'
            : key === 'reservation.review_destination_url'
              ? 'reservation.review_destination_url'
              : 'reservation.review_url',
          { status: 'resolved', value: entry.value }
        );
        if (validated.status !== 'available') {
          throw new PmsProviderError('invalid_response', 'RZ PMS v2 capability URL is invalid.');
        }
        results[key] = { status: 'resolved', value: validated.value };
      } else {
        if (entry.value !== null) {
          throw new PmsProviderError('invalid_response', 'RZ PMS v2 capability response is invalid.');
        }
        const reasons = [
          'feature_disabled', 'not_ready', 'expired',
          'reservation_inactive', 'provider_unsupported',
        ] as const;
        if (entry.reason !== undefined &&
            !reasons.some((reason) => reason === entry.reason)) {
          throw new PmsProviderError('invalid_response', 'RZ PMS v2 capability reason is invalid.');
        }
        results[key] = {
          status: entry.status as 'missing' | 'unsupported',
          value: null,
          ...(typeof entry.reason === 'string'
            ? { reason: entry.reason as typeof reasons[number] }
            : {}),
        };
      }
    }
    return results;
  }
}
