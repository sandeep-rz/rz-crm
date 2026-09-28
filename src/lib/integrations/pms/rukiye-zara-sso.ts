import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { createClient } from '@/lib/supabase/server';

import { RUKIYE_ZARA_PROVIDER } from './types';

const EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_CODE_LENGTH = 4_096;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 120;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const RZ_PMS_SSO_MAX_CODE_LENGTH = MAX_CODE_LENGTH;

export type RukiyeZaraSsoErrorCode =
  | 'exchange_failed'
  | 'identity_not_found'
  | 'mapped_user_missing'
  | 'workspace_access_denied'
  | 'property_mapping_invalid'
  | 'session_failed';

export class RukiyeZaraSsoError extends Error {
  constructor(public readonly code: RukiyeZaraSsoErrorCode) {
    super(code);
    this.name = 'RukiyeZaraSsoError';
  }
}

export interface RukiyeZaraSsoExchange {
  provider: typeof RUKIYE_ZARA_PROVIDER;
  user: {
    external_user_id: string;
    email: string;
    display_name: string;
    host_id: number;
  };
  property_id: string;
  metadata: {
    property_app_connection_id?: string;
    crm_workspace_id?: string;
  };
}

export interface RukiyeZaraSsoPropertyMapping {
  accountId: string;
  integrationId: string;
  propertyId: string;
}

export interface RukiyeZaraSsoAuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface RukiyeZaraSsoDependencies {
  exchangeCode(code: string): Promise<RukiyeZaraSsoExchange>;
  findMappedUserId(externalUserId: string): Promise<string | null>;
  getAuthUser(userId: string): Promise<RukiyeZaraSsoAuthUser | null>;
  findPropertyMappings(
    externalPropertyId: string
  ): Promise<RukiyeZaraSsoPropertyMapping[]>;
  hasMembership(userId: string, accountId: string): Promise<boolean>;
  generateLoginToken(user: RukiyeZaraSsoAuthUser): Promise<string>;
  verifyLoginToken(tokenHash: string): Promise<string>;
  switchAccount(accountId: string): Promise<void>;
  clearSession(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function externalPropertyId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return boundedString(value, MAX_IDENTIFIER_LENGTH);
}

function validateExchangeResponse(
  value: unknown
): RukiyeZaraSsoExchange | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.provider !== RUKIYE_ZARA_PROVIDER) return null;
  if (!isRecord(value.user) || !isRecord(value.metadata)) return null;

  const externalUserId = boundedString(
    value.user.external_user_id,
    MAX_IDENTIFIER_LENGTH
  );
  const email = boundedString(value.user.email, MAX_EMAIL_LENGTH);
  const displayName = boundedString(
    value.user.display_name,
    MAX_DISPLAY_NAME_LENGTH
  );
  const propertyId = externalPropertyId(value.property_id);
  const hostId = value.user.host_id;

  if (
    !externalUserId ||
    !UUID_PATTERN.test(externalUserId) ||
    !email ||
    !EMAIL_PATTERN.test(email) ||
    !displayName ||
    !Number.isSafeInteger(hostId) ||
    (hostId as number) <= 0 ||
    !propertyId
  ) {
    return null;
  }

  const connectionId =
    value.metadata.property_app_connection_id === undefined
      ? undefined
      : boundedString(
          value.metadata.property_app_connection_id,
          MAX_IDENTIFIER_LENGTH
        );
  const workspaceId =
    value.metadata.crm_workspace_id === undefined
      ? undefined
      : boundedString(value.metadata.crm_workspace_id, MAX_IDENTIFIER_LENGTH);

  if (
    (value.metadata.property_app_connection_id !== undefined &&
      !connectionId) ||
    (value.metadata.crm_workspace_id !== undefined &&
      (!workspaceId || !UUID_PATTERN.test(workspaceId)))
  ) {
    return null;
  }

  return {
    provider: RUKIYE_ZARA_PROVIDER,
    user: {
      external_user_id: externalUserId,
      email: email.toLowerCase(),
      display_name: displayName,
      host_id: hostId as number,
    },
    property_id: propertyId,
    metadata: {
      ...(connectionId ? { property_app_connection_id: connectionId } : {}),
      ...(workspaceId ? { crm_workspace_id: workspaceId } : {}),
    },
  };
}

export async function exchangeRukiyeZaraSsoCode(
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<RukiyeZaraSsoExchange> {
  const exchangeUrl = process.env.RZ_PMS_SSO_EXCHANGE_URL?.trim();
  const keyId = process.env.RZ_PMS_API_KEY_ID?.trim();
  const secret = process.env.RZ_PMS_API_SECRET?.trim();
  if (!exchangeUrl || !keyId || !secret) {
    throw new RukiyeZaraSsoError('exchange_failed');
  }

  let url: URL;
  try {
    url = new URL(exchangeUrl);
  } catch {
    throw new RukiyeZaraSsoError('exchange_failed');
  }
  if (url.protocol !== 'https:') {
    throw new RukiyeZaraSsoError('exchange_failed');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        'X-RZ-Key-Id': keyId,
      },
      body: JSON.stringify({ code }),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new RukiyeZaraSsoError('exchange_failed');

    const parsed = await response.json().catch(() => null);
    const validated = validateExchangeResponse(parsed);
    if (!validated) throw new RukiyeZaraSsoError('exchange_failed');
    return validated;
  } catch (error) {
    if (error instanceof RukiyeZaraSsoError) throw error;
    throw new RukiyeZaraSsoError('exchange_failed');
  } finally {
    clearTimeout(timeout);
  }
}

function storageFailure(): never {
  throw new RukiyeZaraSsoError('session_failed');
}

export class SupabaseRukiyeZaraSsoDependencies implements RukiyeZaraSsoDependencies {
  constructor(
    private readonly admin: SupabaseClient,
    private readonly session: SupabaseClient
  ) {}

  exchangeCode(code: string) {
    return exchangeRukiyeZaraSsoCode(code);
  }

  async findMappedUserId(externalUserId: string): Promise<string | null> {
    const { data, error } = await this.admin
      .from('pms_external_identities')
      .select('user_id')
      .eq('provider', RUKIYE_ZARA_PROVIDER)
      .eq('external_user_id', externalUserId)
      .maybeSingle();
    if (error) storageFailure();
    return data?.user_id ?? null;
  }

  async getAuthUser(userId: string): Promise<RukiyeZaraSsoAuthUser | null> {
    const { data, error } = await this.admin.auth.admin.getUserById(userId);
    if (error) {
      const authError = error as { code?: string; status?: number };
      if (authError.code === 'user_not_found' || authError.status === 404) {
        return null;
      }
      storageFailure();
    }

    const user = data.user;
    if (!user) return null;
    return {
      id: user.id,
      email: user.email ?? '',
      emailVerified: Boolean(user.email_confirmed_at),
    };
  }

  async findPropertyMappings(
    externalPropertyId: string
  ): Promise<RukiyeZaraSsoPropertyMapping[]> {
    const { data: properties, error: propertyError } = await this.admin
      .from('pms_properties')
      .select('id, account_id, pms_integration_id')
      .eq('external_property_id', externalPropertyId)
      .eq('status', 'active');
    if (propertyError) storageFailure();
    if (!properties?.length) return [];

    const integrationIds = [
      ...new Set(properties.map((property) => property.pms_integration_id)),
    ];
    const { data: integrations, error: integrationError } = await this.admin
      .from('pms_integrations')
      .select('id, account_id')
      .in('id', integrationIds)
      .eq('provider', RUKIYE_ZARA_PROVIDER)
      .eq('status', 'connected');
    if (integrationError) storageFailure();

    const byId = new Map(
      (integrations ?? []).map((integration) => [integration.id, integration])
    );
    return properties.flatMap((property) => {
      const integration = byId.get(property.pms_integration_id);
      if (!integration || integration.account_id !== property.account_id) {
        return [];
      }
      return [
        {
          accountId: property.account_id,
          integrationId: integration.id,
          propertyId: property.id,
        },
      ];
    });
  }

  async hasMembership(userId: string, accountId: string): Promise<boolean> {
    const { data, error } = await this.admin
      .from('account_members')
      .select('account_id')
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) storageFailure();
    return Boolean(data);
  }

  async generateLoginToken(user: RukiyeZaraSsoAuthUser): Promise<string> {
    const { data, error } = await this.admin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    });
    if (error || !data.properties?.hashed_token || data.user?.id !== user.id) {
      storageFailure();
    }
    return data.properties.hashed_token;
  }

  async verifyLoginToken(tokenHash: string): Promise<string> {
    const { data, error } = await this.session.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'magiclink',
    });
    if (error || !data.session || !data.user) storageFailure();

    // This is the same authenticated lookup used by middleware. Besides
    // confirming the user, it proves the SSR client can read the new session.
    const {
      data: { user },
      error: userError,
    } = await this.session.auth.getUser();
    if (userError || !user) storageFailure();
    return user.id;
  }

  async switchAccount(accountId: string): Promise<void> {
    const { error } = await this.session.rpc('switch_account', {
      p_account_id: accountId,
    });
    if (error) storageFailure();
  }

  async clearSession(): Promise<void> {
    await this.session.auth.signOut().catch(() => undefined);
  }
}

function selectPropertyMapping(
  mappings: RukiyeZaraSsoPropertyMapping[],
  expectedWorkspaceId?: string
): RukiyeZaraSsoPropertyMapping {
  const candidates = expectedWorkspaceId
    ? mappings.filter((mapping) => mapping.accountId === expectedWorkspaceId)
    : mappings;
  if (candidates.length !== 1) {
    throw new RukiyeZaraSsoError('property_mapping_invalid');
  }
  return candidates[0];
}

async function defaultDependencies(): Promise<RukiyeZaraSsoDependencies> {
  return new SupabaseRukiyeZaraSsoDependencies(
    supabaseAdmin(),
    await createClient()
  );
}

export async function establishRukiyeZaraSsoSession(
  code: string,
  dependencies?: RukiyeZaraSsoDependencies
): Promise<{ userId: string; accountId: string }> {
  const deps = dependencies ?? (await defaultDependencies());
  const exchanged = await deps.exchangeCode(code);

  const mappedUserId = await deps.findMappedUserId(
    exchanged.user.external_user_id
  );
  if (!mappedUserId) throw new RukiyeZaraSsoError('identity_not_found');

  const authUser = await deps.getAuthUser(mappedUserId);
  if (!authUser) throw new RukiyeZaraSsoError('mapped_user_missing');
  if (!authUser.email || !authUser.emailVerified) {
    throw new RukiyeZaraSsoError('session_failed');
  }

  const mappings = await deps.findPropertyMappings(exchanged.property_id);
  const mapping = selectPropertyMapping(
    mappings,
    exchanged.metadata.crm_workspace_id
  );

  if (!(await deps.hasMembership(mappedUserId, mapping.accountId))) {
    throw new RukiyeZaraSsoError('workspace_access_denied');
  }

  const tokenHash = await deps.generateLoginToken(authUser);
  try {
    const sessionUserId = await deps.verifyLoginToken(tokenHash);
    if (sessionUserId !== mappedUserId) {
      throw new RukiyeZaraSsoError('session_failed');
    }
    await deps.switchAccount(mapping.accountId);
  } catch (error) {
    await deps.clearSession().catch(() => undefined);
    if (error instanceof RukiyeZaraSsoError) throw error;
    throw new RukiyeZaraSsoError('session_failed');
  }

  return { userId: mappedUserId, accountId: mapping.accountId };
}

export function isValidRukiyeZaraSsoCode(code: string | null): code is string {
  return Boolean(
    code && code.trim().length > 0 && code.length <= MAX_CODE_LENGTH
  );
}

export function isRukiyeZaraSsoError(
  error: unknown
): error is RukiyeZaraSsoError {
  return error instanceof RukiyeZaraSsoError;
}
