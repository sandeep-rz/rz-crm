export const RUKIYE_ZARA_PROVIDER = 'rukiye_zara' as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_EXTERNAL_ID_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_PROPERTY_NAME_LENGTH = 200;

export type InitialSyncStatus = 'pending' | 'syncing' | 'completed' | 'failed';

export interface RukiyeZaraProvisionRequest {
  installation_id: string;
  external_account_id: string;
  owner: {
    external_user_id: string;
    email: string;
    display_name: string;
  };
  property: {
    external_property_id: string;
    name: string;
  };
}

export interface RukiyeZaraProvisionResponse {
  ok: true;
  provider: typeof RUKIYE_ZARA_PROVIDER;
  workspace_id: string;
  integration_id: string;
  crm_property_id: string;
  external_account_id: string;
  external_property_id: string;
  initial_sync_status: InitialSyncStatus;
}

export type ProvisioningErrorCode =
  'identity_claim_required' | 'provisioning_conflict' | 'provisioning_failed';

export class ProvisioningError extends Error {
  constructor(
    public readonly code: ProvisioningErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

export interface ValidationResult {
  success: boolean;
  data?: RukiyeZaraProvisionRequest;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizedString(
  value: unknown,
  label: string,
  maxLength: number
): { value?: string; error?: string } {
  if (typeof value !== 'string') {
    return { error: `${label} must be a string.` };
  }

  const normalized = value.trim();
  if (!normalized) return { error: `${label} is required.` };
  if (normalized.length > maxLength) {
    return { error: `${label} is too long.` };
  }

  return { value: normalized };
}

export function validateProvisionRequest(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { success: false, message: 'Request body must be a JSON object.' };
  }

  if (
    !hasOnlyKeys(value, [
      'installation_id',
      'external_account_id',
      'owner',
      'property',
    ])
  ) {
    return { success: false, message: 'Request contains unsupported fields.' };
  }

  if (!isRecord(value.owner) || !isRecord(value.property)) {
    return { success: false, message: 'Owner and property are required.' };
  }

  if (
    !hasOnlyKeys(value.owner, ['external_user_id', 'email', 'display_name'])
  ) {
    return { success: false, message: 'Owner contains unsupported fields.' };
  }
  if (!hasOnlyKeys(value.property, ['external_property_id', 'name'])) {
    return { success: false, message: 'Property contains unsupported fields.' };
  }

  const installationId = normalizedString(
    value.installation_id,
    'installation_id',
    36
  );
  if (
    installationId.error ||
    !installationId.value ||
    !UUID_PATTERN.test(installationId.value)
  ) {
    return { success: false, message: 'installation_id must be a valid UUID.' };
  }

  const externalAccountId = normalizedString(
    value.external_account_id,
    'external_account_id',
    MAX_EXTERNAL_ID_LENGTH
  );
  if (externalAccountId.error)
    return { success: false, message: externalAccountId.error };

  const externalUserId = normalizedString(
    value.owner.external_user_id,
    'owner.external_user_id',
    MAX_EXTERNAL_ID_LENGTH
  );
  if (externalUserId.error)
    return { success: false, message: externalUserId.error };

  const email = normalizedString(
    value.owner.email,
    'owner.email',
    MAX_EMAIL_LENGTH
  );
  const normalizedEmail = email.value?.toLowerCase();
  if (email.error || !normalizedEmail || !EMAIL_PATTERN.test(normalizedEmail)) {
    return {
      success: false,
      message: 'owner.email must be a valid email address.',
    };
  }

  const displayName = normalizedString(
    value.owner.display_name,
    'owner.display_name',
    MAX_DISPLAY_NAME_LENGTH
  );
  if (displayName.error) return { success: false, message: displayName.error };

  const externalPropertyId = normalizedString(
    value.property.external_property_id,
    'property.external_property_id',
    MAX_EXTERNAL_ID_LENGTH
  );
  if (externalPropertyId.error)
    return { success: false, message: externalPropertyId.error };

  const propertyName = normalizedString(
    value.property.name,
    'property.name',
    MAX_PROPERTY_NAME_LENGTH
  );
  if (propertyName.error)
    return { success: false, message: propertyName.error };

  return {
    success: true,
    data: {
      installation_id: installationId.value,
      external_account_id: externalAccountId.value!,
      owner: {
        external_user_id: externalUserId.value!,
        email: normalizedEmail,
        display_name: displayName.value!,
      },
      property: {
        external_property_id: externalPropertyId.value!,
        name: propertyName.value!,
      },
    },
  };
}
