import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import {
  listMessageVariableDefinitions,
  type MessageVariableDefinition,
  type MessageVariableSourceScope,
} from './catalog';
import {
  buildMessageContext,
  type BuildMessageContextInput,
  type MessageVariableContext,
} from './context';
import {
  validateMessageVariableMappingShape,
  type MessageVariableComponent,
  type MessageVariableMapping,
  type MessageVariableMappingError,
} from './mapping';
import { resolveContextPath } from './resolve-context-path';

export type MessageVariableMissingReason =
  | 'MISSING_CONTEXT_VALUE'
  | 'CUSTOM_FIELD_CONTEXT_MISSING'
  | 'CUSTOM_FIELD_VALUE_MISSING';

export interface ResolvedMessageVariable {
  component: MessageVariableComponent;
  position: number;
  value: string;
  source_type: MessageVariableMapping['source_type'];
  variable_key?: string;
  custom_field_id?: string;
}

export interface MissingMessageVariable {
  component: MessageVariableComponent;
  position: number;
  source_type: MessageVariableMapping['source_type'];
  reason: MessageVariableMissingReason;
  variable_key?: string;
  custom_field_id?: string;
  label?: string;
  source_scope?: MessageVariableSourceScope;
}

export type ResolveMessageVariablesResult =
  | {
      success: true;
      values: ResolvedMessageVariable[];
      missing: [];
      errors: [];
    }
  | {
      success: false;
      values: ResolvedMessageVariable[];
      missing: MissingMessageVariable[];
      errors: MessageVariableMappingError[];
    };

export interface ResolveMessageVariablesInput {
  accountId: string;
  mappings: unknown;
  context: MessageVariableContext;
  db?: SupabaseClient;
}

export interface BuildAndResolveMessageVariablesInput extends BuildMessageContextInput {
  mappings: unknown;
  db?: SupabaseClient;
}

interface CustomFieldRow {
  id: string;
}

interface CustomValueRow {
  custom_field_id: string;
  value: unknown;
}

function usable(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.trim().length > 0)
  );
}

function format(value: string | number | boolean): string {
  return typeof value === 'string' ? value.trim() : String(value);
}

function fallback(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function orderMappings(
  left: MessageVariableMapping,
  right: MessageVariableMapping
): number {
  const componentOrder = { header: 0, body: 1 } as const;
  return (
    componentOrder[left.component] - componentOrder[right.component] ||
    left.position - right.position
  );
}

async function loadOwnedCustomValues(
  db: SupabaseClient,
  accountId: string,
  contactId: string | undefined,
  customFieldIds: string[]
): Promise<{
  owned: Set<string>;
  values: Map<string, unknown>;
}> {
  const { data: fields, error: fieldError } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .in('id', customFieldIds);
  if (fieldError) throw new Error('Custom field lookup failed.');
  const owned = new Set(
    ((fields ?? []) as CustomFieldRow[]).map((field) => field.id)
  );

  if (!contactId || owned.size === 0) return { owned, values: new Map() };

  // A supplied context may have been assembled by a service-role caller, so
  // independently prove contact ownership before reading its custom values.
  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (contactError) throw new Error('Contact ownership lookup failed.');
  if (!contact) return { owned, values: new Map() };

  const { data: rows, error: valueError } = await db
    .from('contact_custom_values')
    .select('custom_field_id, value')
    .eq('contact_id', contactId)
    .in('custom_field_id', [...owned]);
  if (valueError) throw new Error('Custom field value lookup failed.');

  return {
    owned,
    values: new Map(
      ((rows ?? []) as CustomValueRow[]).map((row) => [
        row.custom_field_id,
        row.value,
      ])
    ),
  };
}

/**
 * Resolves provider-neutral semantic mappings into ordered text parameters.
 * Diagnostics contain identity and reason only; resolved values are never
 * copied into validation or missing-value diagnostics.
 */
export async function resolveMessageVariables(
  input: ResolveMessageVariablesInput
): Promise<ResolveMessageVariablesResult> {
  const db = input.db ?? supabaseAdmin();
  if (!input.accountId.trim()) {
    return {
      success: false,
      values: [],
      missing: [],
      errors: [{ code: 'INVALID_ACCOUNT', mapping_index: -1 }],
    };
  }
  if (input.context.workspace.id !== input.accountId) {
    return {
      success: false,
      values: [],
      missing: [],
      errors: [{ code: 'CONTEXT_ACCOUNT_MISMATCH', mapping_index: -1 }],
    };
  }
  const shaped = validateMessageVariableMappingShape(input.mappings);
  if (shaped.errors.length > 0) {
    return {
      success: false,
      values: [],
      missing: [],
      errors: shaped.errors,
    };
  }

  const definitions = await listMessageVariableDefinitions({
    includeInactive: true,
    db,
  });
  const catalog = new Map(
    definitions.map((definition) => [definition.variableKey, definition])
  );
  const errors: MessageVariableMappingError[] = [];

  shaped.mappings.forEach((mapping, mappingIndex) => {
    if (mapping.source_type !== 'catalog_variable') return;
    const definition = catalog.get(mapping.variable_key);
    if (!definition) {
      errors.push({
        code: 'UNKNOWN_CATALOG_VARIABLE',
        mapping_index: mappingIndex,
        component: mapping.component,
        position: mapping.position,
        variable_key: mapping.variable_key,
      });
    } else if (!definition.isActive) {
      errors.push({
        code: 'INACTIVE_CATALOG_VARIABLE',
        mapping_index: mappingIndex,
        component: mapping.component,
        position: mapping.position,
        variable_key: mapping.variable_key,
      });
    }
  });

  const customFieldIds = shaped.mappings
    .filter((mapping) => mapping.source_type === 'custom_field')
    .map((mapping) => mapping.custom_field_id);
  const custom =
    customFieldIds.length > 0
      ? await loadOwnedCustomValues(
          db,
          input.accountId,
          input.context.contact?.id,
          [...new Set(customFieldIds)]
        )
      : { owned: new Set<string>(), values: new Map<string, unknown>() };

  shaped.mappings.forEach((mapping, mappingIndex) => {
    if (
      mapping.source_type === 'custom_field' &&
      !custom.owned.has(mapping.custom_field_id)
    ) {
      errors.push({
        code: 'CUSTOM_FIELD_NOT_FOUND',
        mapping_index: mappingIndex,
        component: mapping.component,
        position: mapping.position,
        custom_field_id: mapping.custom_field_id,
      });
    }
  });

  if (errors.length > 0) {
    return { success: false, values: [], missing: [], errors };
  }

  const values: ResolvedMessageVariable[] = [];
  const missing: MissingMessageVariable[] = [];
  for (const mapping of [...shaped.mappings].sort(orderMappings)) {
    if (mapping.source_type === 'static') {
      values.push({
        component: mapping.component,
        position: mapping.position,
        value: mapping.static_value,
        source_type: mapping.source_type,
      });
      continue;
    }

    if (mapping.source_type === 'custom_field') {
      const raw = custom.values.get(mapping.custom_field_id);
      const selected = usable(raw) ? format(raw) : fallback(mapping.fallback);
      if (selected !== null) {
        values.push({
          component: mapping.component,
          position: mapping.position,
          value: selected,
          source_type: mapping.source_type,
          custom_field_id: mapping.custom_field_id,
        });
      } else {
        missing.push({
          component: mapping.component,
          position: mapping.position,
          source_type: mapping.source_type,
          custom_field_id: mapping.custom_field_id,
          reason: input.context.contact
            ? 'CUSTOM_FIELD_VALUE_MISSING'
            : 'CUSTOM_FIELD_CONTEXT_MISSING',
        });
      }
      continue;
    }

    const definition = catalog.get(
      mapping.variable_key
    ) as MessageVariableDefinition;
    const resolved = resolveContextPath(input.context, definition.resolverKey);
    const runtime =
      resolved.found && usable(resolved.value) ? format(resolved.value) : null;
    const selected =
      runtime ??
      fallback(mapping.fallback) ??
      fallback(definition.defaultFallback);
    if (selected !== null) {
      values.push({
        component: mapping.component,
        position: mapping.position,
        value: selected,
        source_type: mapping.source_type,
        variable_key: mapping.variable_key,
      });
    } else {
      missing.push({
        component: mapping.component,
        position: mapping.position,
        source_type: mapping.source_type,
        variable_key: mapping.variable_key,
        label: definition.label,
        source_scope: definition.sourceScope,
        reason: 'MISSING_CONTEXT_VALUE',
      });
    }
  }

  return missing.length === 0
    ? { success: true, values, missing: [], errors: [] }
    : { success: false, values, missing, errors: [] };
}

/**
 * Production-safe entry point for database-backed CRM entities. Production
 * execution paths should prefer this function so entity ownership and
 * relationships are validated by buildMessageContext before resolution.
 */
export async function buildAndResolveMessageVariables(
  input: BuildAndResolveMessageVariablesInput
): Promise<ResolveMessageVariablesResult> {
  const db = input.db ?? supabaseAdmin();
  const context = await buildMessageContext(
    {
      accountId: input.accountId,
      contactId: input.contactId,
      reservationId: input.reservationId,
      propertyId: input.propertyId,
    },
    db
  );

  return resolveMessageVariables({
    accountId: input.accountId,
    mappings: input.mappings,
    context,
    db,
  });
}
