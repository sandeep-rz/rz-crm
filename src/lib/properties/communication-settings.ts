import type { SupabaseClient } from '@supabase/supabase-js';

export const PROPERTY_COMMUNICATION_FIELDS = [
  'map_url',
  'checkin_method',
  'directions',
  'parking_instructions',
  'nearby_landmark',
  'caretaker_name',
  'caretaker_phone',
  'emergency_phone',
  'wifi_name',
  'wifi_password',
  'house_manual',
  'checkout_instructions',
] as const;

export type PropertyCommunicationField =
  (typeof PROPERTY_COMMUNICATION_FIELDS)[number];

export type PropertyCommunicationValues = Record<
  PropertyCommunicationField,
  string | null
>;

export type PropertyCommunicationPatch = Partial<PropertyCommunicationValues>;

export interface PropertyCommunicationSettings extends PropertyCommunicationValues {
  id: string | null;
  account_id: string;
  pms_property_id: string;
}

export type PropertyCommunicationSettingsErrorCode =
  'invalid_input' | 'property_not_found' | 'lookup_failed' | 'save_failed';

export class PropertyCommunicationSettingsError extends Error {
  constructor(
    readonly code: PropertyCommunicationSettingsErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PropertyCommunicationSettingsError';
  }
}

export function emptyPropertyCommunicationValues(): PropertyCommunicationValues {
  return Object.fromEntries(
    PROPERTY_COMMUNICATION_FIELDS.map((field) => [field, null])
  ) as PropertyCommunicationValues;
}

export function normalizePropertyCommunicationPatch(
  value: unknown
): PropertyCommunicationPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PropertyCommunicationSettingsError(
      'invalid_input',
      'Communication settings must be an object.'
    );
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set<string>(PROPERTY_COMMUNICATION_FIELDS);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new PropertyCommunicationSettingsError(
      'invalid_input',
      'Communication settings contain an unsupported field.'
    );
  }

  const patch: PropertyCommunicationPatch = {};
  for (const field of PROPERTY_COMMUNICATION_FIELDS) {
    if (!(field in input)) continue;
    const raw = input[field];
    if (raw !== null && typeof raw !== 'string') {
      throw new PropertyCommunicationSettingsError(
        'invalid_input',
        `${field} must be a string or null.`
      );
    }
    patch[field] = typeof raw === 'string' ? raw.trim() || null : null;
  }
  return patch;
}

async function requireOwnedProperty(
  db: SupabaseClient,
  accountId: string,
  pmsPropertyId: string
): Promise<void> {
  const { data, error } = await db
    .from('pms_properties')
    .select('id')
    .eq('id', pmsPropertyId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    throw new PropertyCommunicationSettingsError(
      'lookup_failed',
      'Property lookup failed.'
    );
  }
  if (!data) {
    throw new PropertyCommunicationSettingsError(
      'property_not_found',
      'Property not found in this workspace.'
    );
  }
}

function normalizeRow(
  accountId: string,
  pmsPropertyId: string,
  row: Record<string, unknown> | null
): PropertyCommunicationSettings {
  const values = emptyPropertyCommunicationValues();
  if (row) {
    for (const field of PROPERTY_COMMUNICATION_FIELDS) {
      const raw = row[field];
      values[field] = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    }
  }
  return {
    id: typeof row?.id === 'string' ? row.id : null,
    account_id: accountId,
    pms_property_id: pmsPropertyId,
    ...values,
  };
}

export async function getPropertyCommunicationSettings({
  accountId,
  pmsPropertyId,
  db,
}: {
  accountId: string;
  pmsPropertyId: string;
  db: SupabaseClient;
}): Promise<PropertyCommunicationSettings> {
  await requireOwnedProperty(db, accountId, pmsPropertyId);

  const { data, error } = await db
    .from('property_communication_settings')
    .select(`id, ${PROPERTY_COMMUNICATION_FIELDS.join(', ')}`)
    .eq('account_id', accountId)
    .eq('pms_property_id', pmsPropertyId)
    .maybeSingle();
  if (error) {
    throw new PropertyCommunicationSettingsError(
      'lookup_failed',
      'Communication settings lookup failed.'
    );
  }

  return normalizeRow(
    accountId,
    pmsPropertyId,
    data as Record<string, unknown> | null
  );
}

/**
 * Account-scoped upsert seam used by the host UI today and by a future trusted
 * initial-provisioning call. Omitted fields are not sent to PostgREST, so a
 * partial save cannot erase unrelated settings; explicit null clears a field.
 */
export async function upsertPropertyCommunicationSettings({
  accountId,
  pmsPropertyId,
  values,
  db,
}: {
  accountId: string;
  pmsPropertyId: string;
  values: unknown;
  db: SupabaseClient;
}): Promise<PropertyCommunicationSettings> {
  const patch = normalizePropertyCommunicationPatch(values);
  await requireOwnedProperty(db, accountId, pmsPropertyId);

  if (Object.keys(patch).length === 0) {
    return getPropertyCommunicationSettings({ accountId, pmsPropertyId, db });
  }

  const { data, error } = await db
    .from('property_communication_settings')
    .upsert(
      { account_id: accountId, pms_property_id: pmsPropertyId, ...patch },
      {
        onConflict: 'account_id,pms_property_id',
        ignoreDuplicates: false,
        defaultToNull: false,
      }
    )
    .select(`id, ${PROPERTY_COMMUNICATION_FIELDS.join(', ')}`)
    .single();
  if (error || !data) {
    throw new PropertyCommunicationSettingsError(
      'save_failed',
      'Communication settings could not be saved.'
    );
  }

  return normalizeRow(
    accountId,
    pmsPropertyId,
    data as unknown as Record<string, unknown>
  );
}
