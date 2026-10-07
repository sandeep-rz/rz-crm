import 'server-only';
import { PmsHttpClient } from '../http-client';
import { PmsProviderError } from '../provider';
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
    const data = await this.client.post<unknown>(
      '/v1/integrations/rz-crm/variables/resolve',
      {
        contract_version: 'v1',
        context: source,
        variables: keys,
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
    const values: Record<string, ConnectedVariableValue> = {};
    // Whitelist only requested keys; ignore any additional returned values.
    for (const key of keys) {
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
}
