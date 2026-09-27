import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import { RUKIYE_ZARA_PROVIDER } from './types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROVIDER_SECRET_LENGTH = 4096;

export type ProviderAuthenticationErrorCode =
  'invalid_provider_credentials' | 'provider_not_allowed';

export class ProviderAuthenticationError extends Error {
  constructor(
    public readonly code: ProviderAuthenticationErrorCode,
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'ProviderAuthenticationError';
  }
}

interface VerifiedCredential {
  credential_id: string;
  provider: string;
  scopes: string[];
}

function invalidCredentials(): never {
  throw new ProviderAuthenticationError(
    'invalid_provider_credentials',
    401,
    'Provider credentials are missing or invalid.'
  );
}

function parseCredential(data: unknown): VerifiedCredential | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;

  const value = row as Record<string, unknown>;
  if (
    typeof value.credential_id !== 'string' ||
    typeof value.provider !== 'string' ||
    !Array.isArray(value.scopes)
  ) {
    return null;
  }

  return {
    credential_id: value.credential_id,
    provider: value.provider,
    scopes: value.scopes.filter(
      (scope): scope is string => typeof scope === 'string'
    ),
  };
}

export async function authenticateRukiyeZaraProvider(
  request: Request,
  admin: SupabaseClient = supabaseAdmin()
): Promise<VerifiedCredential> {
  const authorization = request.headers.get('authorization');
  const keyId = request.headers.get('x-pms-key-id')?.trim();

  const bearerMatch = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  const rawSecret = bearerMatch?.[1];
  if (
    !rawSecret ||
    rawSecret.length > MAX_PROVIDER_SECRET_LENGTH ||
    !keyId ||
    !UUID_PATTERN.test(keyId)
  ) {
    invalidCredentials();
  }

  const secretHash = createHash('sha256')
    .update(rawSecret, 'utf8')
    .digest('hex');
  const { data, error } = await admin.rpc('verify_pms_provider_credential', {
    p_key_id: keyId,
    p_secret_hash: secretHash,
    p_required_scope: 'provision',
  });

  if (error) {
    invalidCredentials();
  }
  

  const credential = parseCredential(data);
  if (!credential) invalidCredentials();

  if (credential.provider !== RUKIYE_ZARA_PROVIDER) {
    throw new ProviderAuthenticationError(
      'provider_not_allowed',
      403,
      'This provider credential cannot provision Rukiye Zara integrations.'
    );
  }

  return credential;
}
