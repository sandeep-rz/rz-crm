import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { listMessageVariableDefinitions } from './catalog';
import { createConnectedVariableResolver } from '@/lib/integrations/pms/variable-registry';
import { PmsProviderError } from '@/lib/integrations/pms/provider';
import type {
  ConnectedVariableContext,
  ConnectedVariableValue,
} from '@/lib/integrations/pms/variable-resolver';

export interface RuntimeVariableInput {
  accountId: string;
  context: { reservationId?: string };
  variableKeys: string[];
}
export type RuntimeVariableValue = ConnectedVariableValue & {
  source: 'crm' | 'provider';
};
export interface RuntimeVariableFailure {
  httpStatus?: number;
  providerCode?: string;
  code: string;
  source: 'crm' | 'provider' | 'context' | 'catalog';
  variableKeys: string[];
  retryable: boolean;
}
export interface RuntimeVariableResult {
  success: boolean;
  contractVersion: 'v1';
  values: Record<string, RuntimeVariableValue>;
  invalidKeys: string[];
  failures: RuntimeVariableFailure[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
class ContextFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false
  ) {
    super(code);
  }
}

async function connectedContext(
  db: SupabaseClient,
  accountId: string,
  reservationId: string
): Promise<ConnectedVariableContext> {
  const { data: reservation, error: reservationError } = await db
    .from('pms_reservations')
    .select(
      'id,account_id,pms_integration_id,pms_property_id,external_reservation_id,metadata'
    )
    .eq('id', reservationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (reservationError) throw new ContextFailure('lookup_failed', true);
  if (
    !reservation ||
    reservation.id !== reservationId ||
    reservation.account_id !== accountId
  )
    throw new ContextFailure('reservation_not_found');
  const { data: property, error: propertyError } = await db
    .from('pms_properties')
    .select('id,account_id,pms_integration_id,external_property_id,status')
    .eq('id', reservation.pms_property_id)
    .eq('account_id', accountId)
    .eq('pms_integration_id', reservation.pms_integration_id)
    .maybeSingle();
  if (propertyError) throw new ContextFailure('lookup_failed', true);
  if (
    !property ||
    property.id !== reservation.pms_property_id ||
    property.account_id !== accountId ||
    property.pms_integration_id !== reservation.pms_integration_id
  )
    throw new ContextFailure('property_mapping_invalid');
  const { data: integration, error: integrationError } = await db
    .from('pms_integrations')
    .select('id,account_id,provider,external_account_id,status')
    .eq('id', reservation.pms_integration_id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (integrationError) throw new ContextFailure('lookup_failed', true);
  if (
    !integration ||
    integration.id !== reservation.pms_integration_id ||
    integration.account_id !== accountId
  )
    throw new ContextFailure('integration_mapping_invalid');
  if (property.status !== 'active' || integration.status !== 'connected')
    throw new ContextFailure('integration_not_connected');
  if (
    typeof property.external_property_id !== 'string' ||
    !property.external_property_id.trim() ||
    typeof integration.provider !== 'string' ||
    !integration.provider ||
    typeof integration.external_account_id !== 'string' ||
    !integration.external_account_id ||
    typeof reservation.external_reservation_id !== 'string'
  )
    throw new ContextFailure('external_mapping_invalid');
  return {
    accountId,
    integrationId: integration.id,
    provider: integration.provider,
    externalAccountId: integration.external_account_id,
    externalPropertyId: property.external_property_id,
    externalReservationId: reservation.external_reservation_id,
    sourceType:
      object(reservation.metadata) &&
      typeof reservation.metadata.source_type === 'string'
        ? reservation.metadata.source_type
        : '',
  };
}

/** Trusted server callers supply an authorized workspace ID. No browser API or send wiring. */
export async function resolveRuntimeVariables(
  input: RuntimeVariableInput,
  options: {
    db?: SupabaseClient;
    createAdapter?: typeof createConnectedVariableResolver;
  } = {}
): Promise<RuntimeVariableResult> {
  const result: RuntimeVariableResult = {
    success: true,
    contractVersion: 'v1',
    values: {},
    invalidKeys: [],
    failures: [],
  };
  const fail = (
    code: string,
    source: RuntimeVariableFailure['source'],
    keys: string[],
    retryable = false
  ) => {
    result.success = false;
    result.failures.push({ code, source, variableKeys: keys, retryable });
  };
  // Runtime validation also rejects forged provider/source fields from untyped callers.
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) => !['accountId', 'context', 'variableKeys'].includes(key)
    ) ||
    typeof input.accountId !== 'string' ||
    !uuid.test(input.accountId) ||
    !object(input.context) ||
    Object.keys(input.context).some((key) => key !== 'reservationId') ||
    (input.context.reservationId !== undefined &&
      (typeof input.context.reservationId !== 'string' ||
        !uuid.test(input.context.reservationId))) ||
    !Array.isArray(input.variableKeys) ||
    !input.variableKeys.every(
      (key) =>
        typeof key === 'string' &&
        /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(key)
    )
  ) {
    fail('invalid_input', 'context', []);
    return result;
  }
  const keys = [...new Set(input.variableKeys)];
  if (!keys.length) return result;
  let db: SupabaseClient;
  let catalog;
  try {
    db = options.db ?? supabaseAdmin();
    catalog = await listMessageVariableDefinitions({ db });
  } catch {
    fail('catalog_unavailable', 'catalog', keys, true);
    return result;
  }
  result.invalidKeys = keys.filter(
    (key) => !catalog.some((v) => v.variableKey === key && v.isActive)
  );
  if (result.invalidKeys.length) {
    fail('invalid_variables', 'catalog', result.invalidKeys);
    return result;
  }
  // Ownership policy: workspace.name is CRM-owned. Context/derived/provider keys
  // in reservation operations are source-owned and must be late-bound at PMS.
  const local = keys.filter((key) => key === 'workspace.name');
  const remote = keys.filter((key) => key !== 'workspace.name');
  if (local.length) {
    try {
      const { data, error } = await db
        .from('accounts')
        .select('id,name')
        .eq('id', input.accountId)
        .maybeSingle();
      if (error) throw new ContextFailure('lookup_failed', true);
      if (!data || data.id !== input.accountId)
        throw new ContextFailure('workspace_not_found');
      result.values['workspace.name'] =
        typeof data.name === 'string' && data.name.trim()
          ? { status: 'resolved', value: data.name, source: 'crm' }
          : { status: 'missing', value: null, source: 'crm' };
    } catch (error) {
      fail(
        error instanceof ContextFailure ? error.code : 'lookup_failed',
        'crm',
        local,
        !(error instanceof ContextFailure) || error.retryable
      );
    }
  }
  if (!remote.length) return result;
  if (!input.context.reservationId) {
    fail('reservation_context_required', 'context', remote);
    return result;
  }
  let context: ConnectedVariableContext;
  try {
    context = await connectedContext(
      db,
      input.accountId,
      input.context.reservationId
    );
  } catch (error) {
    fail(
      error instanceof ContextFailure ? error.code : 'lookup_failed',
      'context',
      remote,
      !(error instanceof ContextFailure) || error.retryable
    );
    return result;
  }
  try {
    const adapter = (options.createAdapter ?? createConnectedVariableResolver)(
      context.provider
    );
    const values = await adapter.resolveVariables({
      context,
      variableKeys: remote,
    });
    // Do not allow a future adapter to inject extra keys or partially succeed.
    for (const key of remote) {
      if (!Object.hasOwn(values, key))
        throw new PmsProviderError(
          'invalid_response',
          'Missing variable result.'
        );
    }
    for (const key of remote)
      result.values[key] = { ...values[key], source: 'provider' };
  } catch (error) {
    const code =
      error instanceof PmsProviderError ? error.code : 'upstream_temporary';
    fail(
      code,
      'provider',
      remote,
      [
        'timeout',
        'rate_limited',
        'upstream_temporary',
        'invalid_response',
      ].includes(code)
    );
    if (error instanceof PmsProviderError && error.diagnostics)
      Object.assign(
        result.failures[result.failures.length - 1],
        error.diagnostics
      );
  }
  return result;
}
