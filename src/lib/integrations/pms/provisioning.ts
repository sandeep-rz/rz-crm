import { randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  normalizePropertyCommunicationPatch,
  type PropertyCommunicationPatch,
} from '@/lib/properties/communication-settings';
import type { PmsPropertyCommunication } from './provider';

import {
  type InitialSyncStatus,
  type RukiyeZaraProvisionRequest,
  type RukiyeZaraProvisionResponse,
  ProvisioningError,
  RUKIYE_ZARA_PROVIDER,
} from './types';

export interface ExternalIdentity {
  user_id: string;
  external_email: string | null;
}

export interface IntegrationRecord {
  id: string;
  account_id: string;
  connected_at: string | null;
  metadata: Record<string, unknown>;
}

export interface PropertyRecord {
  id: string;
  initial_sync_status: InitialSyncStatus;
  timezone: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateAuthUserInput {
  email: string;
  displayName: string;
}

export interface CreateIdentityInput {
  externalUserId: string;
  userId: string;
  email: string;
}

export interface IntegrationWriteInput {
  id?: string;
  accountId: string;
  externalAccountId: string;
  connectedAt: string;
  metadata: Record<string, unknown>;
}

export interface PropertyWriteInput {
  id?: string;
  accountId: string;
  integrationId: string;
  externalPropertyId: string;
  name: string;
  timezone: string | null;
  metadata: Record<string, unknown>;
}

export interface PropertyCommunicationInitializationInput {
  accountId: string;
  propertyId: string;
  values: PropertyCommunicationPatch;
}

export interface PmsProvisioningStore {
  findExternalIdentity(
    externalUserId: string
  ): Promise<ExternalIdentity | null>;
  createAuthUser(input: CreateAuthUserInput): Promise<string>;
  deleteAuthUser(userId: string): Promise<void>;
  createExternalIdentity(input: CreateIdentityInput): Promise<void>;
  findIntegrations(externalAccountId: string): Promise<IntegrationRecord[]>;
  listMembershipAccountIds(userId: string): Promise<string[]>;
  findOldestOwnedAccount(userId: string): Promise<string | null>;
  createIntegration(input: IntegrationWriteInput): Promise<IntegrationRecord>;
  updateIntegration(
    input: IntegrationWriteInput & { id: string }
  ): Promise<IntegrationRecord>;
  findProperty(
    integrationId: string,
    externalPropertyId: string
  ): Promise<PropertyRecord | null>;
  createProperty(input: PropertyWriteInput): Promise<PropertyRecord>;
  createPropertyCommunicationIfAbsent(
    input: PropertyCommunicationInitializationInput
  ): Promise<void>;
  deleteProperty(input: {
    id: string;
    accountId: string;
    integrationId: string;
  }): Promise<void>;
  updateProperty(
    input: PropertyWriteInput & { id: string }
  ): Promise<PropertyRecord>;
}

export class StoreConflictError extends Error {
  constructor() {
    super('Unique constraint conflict');
    this.name = 'StoreConflictError';
  }
}

export class IdentityClaimRequiredError extends Error {
  constructor() {
    super('Existing CRM identity requires an authenticated claim');
    this.name = 'IdentityClaimRequiredError';
  }
}

class ProvisioningStoreError extends Error {
  constructor() {
    super('Provisioning storage operation failed');
    this.name = 'ProvisioningStoreError';
  }
}

function asMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isInitialSyncStatus(value: unknown): value is InitialSyncStatus {
  return (
    value === 'pending' ||
    value === 'syncing' ||
    value === 'completed' ||
    value === 'failed'
  );
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

function storageFailure(error: unknown): never {
  void error;
  throw new ProvisioningStoreError();
}

export class SupabasePmsProvisioningStore implements PmsProvisioningStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async findExternalIdentity(
    externalUserId: string
  ): Promise<ExternalIdentity | null> {
    const { data, error } = await this.admin
      .from('pms_external_identities')
      .select('user_id, external_email')
      .eq('provider', RUKIYE_ZARA_PROVIDER)
      .eq('external_user_id', externalUserId)
      .maybeSingle();
    if (error) storageFailure(error);
    return data as ExternalIdentity | null;
  }

  async createAuthUser(input: CreateAuthUserInput): Promise<string> {
    const password = randomBytes(48).toString('base64url');
    const { data, error } = await this.admin.auth.admin.createUser({
      email: input.email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: input.displayName,
        full_name: input.displayName,
        source: RUKIYE_ZARA_PROVIDER,
        provider: RUKIYE_ZARA_PROVIDER,
      },
    });

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === 'email_exists' || code === 'user_already_exists') {
        throw new IdentityClaimRequiredError();
      }
      storageFailure(error);
    }
    if (!data.user?.id) storageFailure(null);
    return data.user.id;
  }

  async deleteAuthUser(userId: string): Promise<void> {
    const { error } = await this.admin.auth.admin.deleteUser(userId);
    if (error) storageFailure(error);
  }

  async createExternalIdentity(input: CreateIdentityInput): Promise<void> {
    const { error } = await this.admin.from('pms_external_identities').insert({
      provider: RUKIYE_ZARA_PROVIDER,
      external_user_id: input.externalUserId,
      user_id: input.userId,
      external_email: input.email,
      metadata: { provisioned_by: 'rz_pms' },
    });
    if (isUniqueViolation(error)) throw new StoreConflictError();
    if (error) storageFailure(error);
  }

  async findIntegrations(
    externalAccountId: string
  ): Promise<IntegrationRecord[]> {
    const { data, error } = await this.admin
      .from('pms_integrations')
      .select('id, account_id, connected_at, metadata')
      .eq('provider', RUKIYE_ZARA_PROVIDER)
      .eq('external_account_id', externalAccountId)
      .order('created_at', { ascending: true });
    if (error) storageFailure(error);
    return (data ?? []).map((row) => ({
      id: row.id,
      account_id: row.account_id,
      connected_at: row.connected_at,
      metadata: asMetadata(row.metadata),
    }));
  }

  async listMembershipAccountIds(userId: string): Promise<string[]> {
    const { data, error } = await this.admin
      .from('account_members')
      .select('account_id')
      .eq('user_id', userId);
    if (error) storageFailure(error);
    return (data ?? []).map((row) => row.account_id as string);
  }

  async findOldestOwnedAccount(userId: string): Promise<string | null> {
    const { data, error } = await this.admin
      .from('accounts')
      .select('id')
      .eq('owner_user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) storageFailure(error);
    return data?.id ?? null;
  }

  async createIntegration(
    input: IntegrationWriteInput
  ): Promise<IntegrationRecord> {
    const { data, error } = await this.admin
      .from('pms_integrations')
      .insert({
        account_id: input.accountId,
        provider: RUKIYE_ZARA_PROVIDER,
        external_account_id: input.externalAccountId,
        display_name: 'Rukiye Zara PMS',
        status: 'connected',
        integration_version: 'v1',
        connected_at: input.connectedAt,
        metadata: input.metadata,
      })
      .select('id, account_id, connected_at, metadata')
      .single();
    if (isUniqueViolation(error)) throw new StoreConflictError();
    if (error || !data) storageFailure(error);
    return {
      id: data.id,
      account_id: data.account_id,
      connected_at: data.connected_at,
      metadata: asMetadata(data.metadata),
    };
  }

  async updateIntegration(
    input: IntegrationWriteInput & { id: string }
  ): Promise<IntegrationRecord> {
    const { data, error } = await this.admin
      .from('pms_integrations')
      .update({
        display_name: 'Rukiye Zara PMS',
        status: 'connected',
        integration_version: 'v1',
        connected_at: input.connectedAt,
        metadata: input.metadata,
      })
      .eq('id', input.id)
      .eq('account_id', input.accountId)
      .select('id, account_id, connected_at, metadata')
      .single();
    if (error || !data) storageFailure(error);
    return {
      id: data.id,
      account_id: data.account_id,
      connected_at: data.connected_at,
      metadata: asMetadata(data.metadata),
    };
  }

  async findProperty(
    integrationId: string,
    externalPropertyId: string
  ): Promise<PropertyRecord | null> {
    const { data, error } = await this.admin
      .from('pms_properties')
      .select('id, initial_sync_status, timezone, metadata')
      .eq('pms_integration_id', integrationId)
      .eq('external_property_id', externalPropertyId)
      .maybeSingle();
    if (error) storageFailure(error);
    if (!data) return null;
    if (!isInitialSyncStatus(data.initial_sync_status)) storageFailure(null);
    return {
      id: data.id,
      initial_sync_status: data.initial_sync_status,
      timezone: data.timezone as string | null,
      metadata: asMetadata(data.metadata),
    };
  }

  async createProperty(input: PropertyWriteInput): Promise<PropertyRecord> {
    const { data, error } = await this.admin
      .from('pms_properties')
      .insert({
        account_id: input.accountId,
        pms_integration_id: input.integrationId,
        external_property_id: input.externalPropertyId,
        name: input.name,
        timezone: input.timezone,
        status: 'active',
        initial_sync_status: 'pending',
        metadata: input.metadata,
      })
      .select('id, initial_sync_status, timezone, metadata')
      .single();
    if (isUniqueViolation(error)) throw new StoreConflictError();
    if (error || !data || !isInitialSyncStatus(data.initial_sync_status))
      storageFailure(error);
    return {
      id: data.id,
      initial_sync_status: data.initial_sync_status,
      timezone: data.timezone as string | null,
      metadata: asMetadata(data.metadata),
    };
  }

  async createPropertyCommunicationIfAbsent(
    input: PropertyCommunicationInitializationInput
  ): Promise<void> {
    const { error } = await this.admin
      .from('property_communication_settings')
      .upsert(
        {
          account_id: input.accountId,
          pms_property_id: input.propertyId,
          ...input.values,
        },
        {
          onConflict: 'account_id,pms_property_id',
          ignoreDuplicates: true,
          defaultToNull: false,
        }
      );
    if (error) storageFailure(error);
  }

  async deleteProperty(input: {
    id: string;
    accountId: string;
    integrationId: string;
  }): Promise<void> {
    const { error } = await this.admin
      .from('pms_properties')
      .delete()
      .eq('id', input.id)
      .eq('account_id', input.accountId)
      .eq('pms_integration_id', input.integrationId);
    if (error) storageFailure(error);
  }

  async updateProperty(
    input: PropertyWriteInput & { id: string }
  ): Promise<PropertyRecord> {
    const { data, error } = await this.admin
      .from('pms_properties')
      .update({
        name: input.name,
        timezone: input.timezone,
        status: 'active',
        metadata: input.metadata,
      })
      .eq('id', input.id)
      .eq('account_id', input.accountId)
      .eq('pms_integration_id', input.integrationId)
      .select('id, initial_sync_status, timezone, metadata')
      .single();
    if (error || !data || !isInitialSyncStatus(data.initial_sync_status))
      storageFailure(error);
    return {
      id: data.id,
      initial_sync_status: data.initial_sync_status,
      timezone: data.timezone as string | null,
      metadata: asMetadata(data.metadata),
    };
  }
}

function initialCommunicationValues(
  communication: PmsPropertyCommunication | null | undefined
): PropertyCommunicationPatch | null {
  if (!communication) return null;
  const normalized = normalizePropertyCommunicationPatch(communication);
  const present = Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== null)
  ) as PropertyCommunicationPatch;
  return Object.keys(present).length > 0 ? present : null;
}

async function resolveIdentity(
  request: RukiyeZaraProvisionRequest,
  store: PmsProvisioningStore
): Promise<string> {
  const mapped = await store.findExternalIdentity(
    request.owner.external_user_id
  );
  if (mapped) return mapped.user_id;

  let newUserId: string;
  try {
    newUserId = await store.createAuthUser({
      email: request.owner.email,
      displayName: request.owner.display_name,
    });
  } catch (error) {
    if (error instanceof IdentityClaimRequiredError) {
      // A concurrent identical request may have completed the durable mapping
      // between the failed createUser call and this lookup.
      const concurrentMapping = await store.findExternalIdentity(
        request.owner.external_user_id
      );
      if (concurrentMapping) return concurrentMapping.user_id;

      throw new ProvisioningError(
        'identity_claim_required',
        'This email already belongs to an existing CRM account and must be linked through an authenticated account claim.'
      );
    }
    throw error;
  }

  try {
    await store.createExternalIdentity({
      externalUserId: request.owner.external_user_id,
      userId: newUserId,
      email: request.owner.email,
    });
    return newUserId;
  } catch (error) {
    if (error instanceof StoreConflictError) {
      const concurrentMapping = await store.findExternalIdentity(
        request.owner.external_user_id
      );
      try {
        await store.deleteAuthUser(newUserId);
      } catch {
        throw new ProvisioningError(
          'provisioning_conflict',
          'The external identity was provisioned concurrently and cleanup could not be completed.'
        );
      }
      if (concurrentMapping) return concurrentMapping.user_id;
    } else {
      try {
        await store.deleteAuthUser(newUserId);
      } catch {
        // Preserve the original stable failure. No secret or database detail is exposed.
      }
    }
    throw error;
  }
}

async function resolveWorkspaceAndIntegration(
  request: RukiyeZaraProvisionRequest,
  userId: string,
  store: PmsProvisioningStore
): Promise<IntegrationRecord> {
  const [integrations, memberAccountIds] = await Promise.all([
    store.findIntegrations(request.external_account_id),
    store.listMembershipAccountIds(userId),
  ]);
  const memberships = new Set(memberAccountIds);

  if (integrations.length > 1) {
    throw new ProvisioningError(
      'provisioning_conflict',
      'This PMS business is associated with more than one CRM workspace.'
    );
  }

  const integration = integrations[0] ?? null;
  let accountId: string;

  if (integration) {
    if (!memberships.has(integration.account_id)) {
      throw new ProvisioningError(
        'provisioning_conflict',
        'This PMS business is already associated with another CRM workspace.'
      );
    }
    accountId = integration.account_id;
  } else {
    const ownedAccountId = await store.findOldestOwnedAccount(userId);
    if (!ownedAccountId || !memberships.has(ownedAccountId)) {
      throw new ProvisioningError(
        'provisioning_failed',
        'The CRM user does not have a valid owned workspace.'
      );
    }
    accountId = ownedAccountId;
  }

  const now = new Date().toISOString();
  const environment = process.env.RZ_PMS_ENVIRONMENT?.trim() || 'dev';
  const metadata = {
    ...(integration?.metadata ?? {}),
    provisioned_by: 'rz_pms',
    environment,
  };

  if (integration) {
    return store.updateIntegration({
      id: integration.id,
      accountId,
      externalAccountId: request.external_account_id,
      connectedAt: integration.connected_at ?? now,
      metadata,
    });
  }

  try {
    return await store.createIntegration({
      accountId,
      externalAccountId: request.external_account_id,
      connectedAt: now,
      metadata,
    });
  } catch (error) {
    if (!(error instanceof StoreConflictError)) throw error;
    const retryMatches = await store.findIntegrations(
      request.external_account_id
    );
    const retry = retryMatches.find(
      (candidate) => candidate.account_id === accountId
    );
    if (retryMatches.length !== 1 || !retry) {
      throw new ProvisioningError(
        'provisioning_conflict',
        'This PMS business was provisioned concurrently into another CRM workspace.'
      );
    }
    return store.updateIntegration({
      id: retry.id,
      accountId,
      externalAccountId: request.external_account_id,
      connectedAt: retry.connected_at ?? now,
      metadata: { ...retry.metadata, ...metadata },
    });
  }
}

async function resolveProperty(
  request: RukiyeZaraProvisionRequest,
  integration: IntegrationRecord,
  store: PmsProvisioningStore
): Promise<PropertyRecord> {
  let property = await store.findProperty(
    integration.id,
    request.property.external_property_id
  );
  const metadata = {
    ...(property?.metadata ?? {}),
    installation_id: request.installation_id,
  };

  if (property) {
    return store.updateProperty({
      id: property.id,
      accountId: integration.account_id,
      integrationId: integration.id,
      externalPropertyId: request.property.external_property_id,
      name: request.property.name,
      timezone: request.property.timezone ?? property.timezone,
      metadata,
    });
  }

  let created: PropertyRecord;
  try {
    created = await store.createProperty({
      accountId: integration.account_id,
      integrationId: integration.id,
      externalPropertyId: request.property.external_property_id,
      name: request.property.name,
      timezone: request.property.timezone ?? null,
      metadata,
    });
  } catch (error) {
    if (!(error instanceof StoreConflictError)) throw error;
    property = await store.findProperty(
      integration.id,
      request.property.external_property_id
    );
    if (!property) throw error;
    return store.updateProperty({
      id: property.id,
      accountId: integration.account_id,
      integrationId: integration.id,
      externalPropertyId: request.property.external_property_id,
      name: request.property.name,
      timezone: request.property.timezone ?? property.timezone,
      metadata: { ...property.metadata, ...metadata },
    });
  }

  const communication = initialCommunicationValues(
    request.property.communication
  );
  if (communication) {
    try {
      await store.createPropertyCommunicationIfAbsent({
        accountId: integration.account_id,
        propertyId: created.id,
        values: communication,
      });
    } catch (error) {
      try {
        await store.deleteProperty({
          id: created.id,
          accountId: integration.account_id,
          integrationId: integration.id,
        });
      } catch {
        // Preserve the initialization failure. The create-if-absent write is
        // idempotent, and the database FK still prevents cross-account data.
      }
      throw error;
    }
  }

  return created;
}

export async function provisionRukiyeZara(
  request: RukiyeZaraProvisionRequest,
  store: PmsProvisioningStore = new SupabasePmsProvisioningStore()
): Promise<RukiyeZaraProvisionResponse> {
  try {
    const userId = await resolveIdentity(request, store);
    const integration = await resolveWorkspaceAndIntegration(
      request,
      userId,
      store
    );
    const property = await resolveProperty(request, integration, store);

    return {
      ok: true,
      provider: RUKIYE_ZARA_PROVIDER,
      workspace_id: integration.account_id,
      integration_id: integration.id,
      crm_property_id: property.id,
      external_account_id: request.external_account_id,
      external_property_id: request.property.external_property_id,
      initial_sync_status: property.initial_sync_status,
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    throw new ProvisioningError(
      'provisioning_failed',
      'The CRM workspace could not be provisioned.'
    );
  }
}
