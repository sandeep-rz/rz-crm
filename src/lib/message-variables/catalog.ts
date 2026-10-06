import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

// Shared vocabulary metadata is safe to import in client-side pickers.
export * from './contract';
import type {
  MessageVariableDataType,
  MessageVariableResolutionSource,
  MessageVariableSourceScope,
} from './contract';

export interface MessageVariableDefinition {
  id: string;
  variableKey: string;
  label: string;
  description: string | null;
  category: MessageVariableSourceScope;
  dataType: MessageVariableDataType;
  sourceScope: MessageVariableSourceScope;
  resolutionSource: MessageVariableResolutionSource;
  resolverKey: string;
  previewValue: string | null;
  defaultFallback: string | null;
  isSensitive: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface WorkspaceCustomFieldVariable {
  kind: 'custom_field';
  id: string;
  label: string;
  dataType: string;
}

/**
 * Stable picker seam for the later UI phase. Global semantic variables and
 * workspace-defined custom fields remain separate sources so custom fields are
 * never duplicated into the global catalog.
 */
export interface MessageVariablePickerSource {
  predefined: MessageVariableDefinition[];
  customFields: WorkspaceCustomFieldVariable[];
}

interface CatalogRow {
  id: string;
  variable_key: string;
  label: string;
  description: string | null;
  category: MessageVariableSourceScope;
  data_type: MessageVariableDataType;
  source_scope: MessageVariableSourceScope;
  resolution_source?: MessageVariableResolutionSource;
  resolver_key: string;
  preview_value: string | null;
  default_fallback: string | null;
  is_sensitive: boolean;
  is_active: boolean;
  sort_order: number;
}

export class MessageVariableCatalogError extends Error {
  constructor() {
    super('Message variable catalog lookup failed.');
    this.name = 'MessageVariableCatalogError';
  }
}

export async function listMessageVariableDefinitions(
  options: {
    includeInactive?: boolean;
    db?: SupabaseClient;
  } = {}
): Promise<MessageVariableDefinition[]> {
  const db = options.db ?? supabaseAdmin();
  let query = db
    .from('message_variable_catalog')
    .select(
      'id, variable_key, label, description, category, data_type, source_scope, resolution_source, resolver_key, preview_value, default_fallback, is_sensitive, is_active, sort_order'
    );
  if (!options.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query
    .order('sort_order', { ascending: true })
    .order('variable_key', { ascending: true });
  if (error) throw new MessageVariableCatalogError();

  return ((data ?? []) as CatalogRow[]).map((row) => ({
    id: row.id,
    variableKey: row.variable_key,
    label: row.label,
    description: row.description,
    category: row.category,
    dataType: row.data_type,
    sourceScope: row.source_scope,
    resolutionSource: row.resolution_source ?? 'context',
    resolverKey: row.resolver_key,
    previewValue: row.preview_value,
    defaultFallback: row.default_fallback,
    isSensitive: row.is_sensitive,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  }));
}

export async function getMessageVariablePickerSource(
  options: {
    includeInactive?: boolean;
    db?: SupabaseClient;
  } = {}
): Promise<MessageVariablePickerSource> {
  return {
    predefined: await listMessageVariableDefinitions(options),
    // Phase 1 deliberately does not synthesize catalog rows from custom_fields.
    // A later picker can load that account-scoped source into this slot.
    customFields: [],
  };
}
