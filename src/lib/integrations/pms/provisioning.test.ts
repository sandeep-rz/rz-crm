import { beforeEach, describe, expect, it } from 'vitest';

import {
  type CreateAuthUserInput,
  type CreateIdentityInput,
  type ExternalIdentity,
  type IntegrationRecord,
  type IntegrationWriteInput,
  type PmsProvisioningStore,
  type PropertyCommunicationInitializationInput,
  type PropertyRecord,
  type PropertyWriteInput,
  IdentityClaimRequiredError,
  StoreConflictError,
  provisionRukiyeZara,
} from './provisioning';
import type { RukiyeZaraProvisionRequest } from './types';

const REQUEST: RukiyeZaraProvisionRequest = {
  installation_id: '11111111-1111-4111-8111-111111111111',
  external_account_id: 'host-74115',
  owner: {
    external_user_id: 'rz-user-9',
    email: 'owner@example.com',
    display_name: 'Owner Name',
  },
  property: {
    external_property_id: '22008',
    name: 'Lakeside Meadows',
  },
};

interface StoredIntegration extends IntegrationRecord {
  externalAccountId: string;
}

interface StoredProperty extends PropertyRecord {
  integrationId: string;
  externalPropertyId: string;
  accountId: string;
  name: string;
}

class MemoryProvisioningStore implements PmsProvisioningStore {
  identities = new Map<string, ExternalIdentity>();
  usersByEmail = new Map<string, string>();
  accountsByOwner = new Map<string, string[]>();
  memberships = new Map<string, Set<string>>();
  integrations = new Map<string, StoredIntegration>();
  properties = new Map<string, StoredProperty>();
  communication = new Map<string, Record<string, string | null>>();
  communicationInitializations: PropertyCommunicationInitializationInput[] = [];
  failCommunicationInitialization = false;
  createAuthCalls = 0;
  deletedUsers: string[] = [];

  private userSequence = 0;
  private accountSequence = 0;
  private integrationSequence = 0;
  private propertySequence = 0;

  seedUser(email: string, withWorkspace = true): string {
    const userId = `crm-user-${++this.userSequence}`;
    this.usersByEmail.set(email, userId);
    if (withWorkspace) this.seedWorkspace(userId);
    return userId;
  }

  seedWorkspace(userId: string): string {
    const accountId = `workspace-${++this.accountSequence}`;
    const accounts = this.accountsByOwner.get(userId) ?? [];
    accounts.push(accountId);
    this.accountsByOwner.set(userId, accounts);
    const memberships = this.memberships.get(userId) ?? new Set<string>();
    memberships.add(accountId);
    this.memberships.set(userId, memberships);
    return accountId;
  }

  seedIdentity(
    externalUserId: string,
    userId: string,
    email = 'old@example.com'
  ) {
    this.identities.set(externalUserId, {
      user_id: userId,
      external_email: email,
    });
  }

  seedCompletedProperty(
    integrationId: string,
    accountId: string,
    externalPropertyId: string
  ): PropertyRecord {
    const record: StoredProperty = {
      id: `property-${++this.propertySequence}`,
      integrationId,
      externalPropertyId,
      accountId,
      name: 'Already synced',
      initial_sync_status: 'completed',
      timezone: null,
      metadata: { retained: true, accountId },
    };
    this.properties.set(`${integrationId}:${externalPropertyId}`, record);
    return record;
  }

  async findExternalIdentity(externalUserId: string) {
    return this.identities.get(externalUserId) ?? null;
  }

  async createAuthUser(input: CreateAuthUserInput) {
    this.createAuthCalls += 1;
    if (this.usersByEmail.has(input.email))
      throw new IdentityClaimRequiredError();
    return this.seedUser(input.email);
  }

  async deleteAuthUser(userId: string) {
    this.deletedUsers.push(userId);
    for (const [email, id] of this.usersByEmail) {
      if (id === userId) this.usersByEmail.delete(email);
    }
    const owned = this.accountsByOwner.get(userId) ?? [];
    this.accountsByOwner.delete(userId);
    this.memberships.delete(userId);
    for (const [externalUserId, identity] of this.identities) {
      if (identity.user_id === userId) this.identities.delete(externalUserId);
    }
    for (const accountId of owned) {
      for (const [id, integration] of this.integrations) {
        if (integration.account_id === accountId) this.integrations.delete(id);
      }
    }
  }

  async createExternalIdentity(input: CreateIdentityInput) {
    if (this.identities.has(input.externalUserId))
      throw new StoreConflictError();
    this.identities.set(input.externalUserId, {
      user_id: input.userId,
      external_email: input.email,
    });
  }

  async findIntegrations(externalAccountId: string) {
    return [...this.integrations.values()].filter(
      (integration) => integration.externalAccountId === externalAccountId
    );
  }

  async listMembershipAccountIds(userId: string) {
    return [...(this.memberships.get(userId) ?? new Set<string>())];
  }

  async findOldestOwnedAccount(userId: string) {
    return this.accountsByOwner.get(userId)?.[0] ?? null;
  }

  async createIntegration(input: IntegrationWriteInput) {
    const duplicate = [...this.integrations.values()].find(
      (integration) =>
        integration.account_id === input.accountId &&
        integration.externalAccountId === input.externalAccountId
    );
    if (duplicate) throw new StoreConflictError();

    const record: StoredIntegration = {
      id: `integration-${++this.integrationSequence}`,
      account_id: input.accountId,
      connected_at: input.connectedAt,
      metadata: input.metadata,
      externalAccountId: input.externalAccountId,
    };
    this.integrations.set(record.id, record);
    return record;
  }

  async updateIntegration(input: IntegrationWriteInput & { id: string }) {
    const current = this.integrations.get(input.id);
    if (!current) throw new Error('missing integration');
    const record: StoredIntegration = {
      ...current,
      connected_at: input.connectedAt,
      metadata: input.metadata,
    };
    this.integrations.set(record.id, record);
    return record;
  }

  async findProperty(integrationId: string, externalPropertyId: string) {
    return (
      this.properties.get(`${integrationId}:${externalPropertyId}`) ?? null
    );
  }

  async createProperty(input: PropertyWriteInput) {
    const key = `${input.integrationId}:${input.externalPropertyId}`;
    if (this.properties.has(key)) throw new StoreConflictError();
    const record: StoredProperty = {
      id: `property-${++this.propertySequence}`,
      integrationId: input.integrationId,
      externalPropertyId: input.externalPropertyId,
      accountId: input.accountId,
      name: input.name,
      initial_sync_status: 'pending',
      timezone: input.timezone,
      metadata: input.metadata,
    };
    this.properties.set(key, record);
    return record;
  }

  async createPropertyCommunicationIfAbsent(
    input: PropertyCommunicationInitializationInput
  ) {
    if (this.failCommunicationInitialization) {
      this.failCommunicationInitialization = false;
      throw new Error('communication initialization failed');
    }
    const property = [...this.properties.values()].find(
      (candidate) => candidate.id === input.propertyId
    );
    if (!property || property.accountId !== input.accountId) {
      throw new Error('cross-account property communication write');
    }
    this.communicationInitializations.push(input);
    if (!this.communication.has(input.propertyId)) {
      this.communication.set(
        input.propertyId,
        input.values as Record<string, string | null>
      );
    }
  }

  async deleteProperty(input: {
    id: string;
    accountId: string;
    integrationId: string;
  }) {
    const entry = [...this.properties.entries()].find(
      ([, property]) =>
        property.id === input.id &&
        property.integrationId === input.integrationId &&
        property.accountId === input.accountId
    );
    if (entry) this.properties.delete(entry[0]);
    this.communication.delete(input.id);
  }

  async updateProperty(input: PropertyWriteInput & { id: string }) {
    const key = `${input.integrationId}:${input.externalPropertyId}`;
    const current = this.properties.get(key);
    if (!current || current.id !== input.id)
      throw new Error('missing property');
    const record: StoredProperty = {
      ...current,
      name: input.name,
      timezone: input.timezone,
      metadata: input.metadata,
    };
    this.properties.set(key, record);
    return record;
  }
}

let store: MemoryProvisioningStore;

beforeEach(() => {
  store = new MemoryProvisioningStore();
});

describe('Rukiye Zara PMS provisioning', () => {
  it('stores the property timezone supplied by RZ PMS', async () => {
    await provisionRukiyeZara(
      {
        ...REQUEST,
        property: { ...REQUEST.property, timezone: 'Asia/Kolkata' },
      },
      store
    );

    const property = [...store.properties.values()][0];
    expect(property.timezone).toBe('Asia/Kolkata');
  });

  it('creates a new CRM user, trigger-owned workspace, integration, and property', async () => {
    const result = await provisionRukiyeZara(REQUEST, store);

    const identity = store.identities.get(REQUEST.owner.external_user_id);
    expect(store.createAuthCalls).toBe(1);
    expect(identity).toBeTruthy();
    expect(result).toEqual({
      ok: true,
      provider: 'rukiye_zara',
      workspace_id: 'workspace-1',
      integration_id: 'integration-1',
      crm_property_id: 'property-1',
      external_account_id: REQUEST.external_account_id,
      external_property_id: REQUEST.property.external_property_id,
      initial_sync_status: 'pending',
    });
  });

  it('initializes partial communication only when creating a new property', async () => {
    const result = await provisionRukiyeZara(
      {
        ...REQUEST,
        property: {
          ...REQUEST.property,
          communication: {
            map_url: ' https://maps.example/lakeside ',
            caretaker_phone: null,
          },
        },
      },
      store
    );

    expect(store.communication.get(result.crm_property_id)).toEqual({
      map_url: 'https://maps.example/lakeside',
    });
    expect(store.communicationInitializations[0]).toMatchObject({
      accountId: result.workspace_id,
      propertyId: result.crm_property_id,
    });
  });

  it('does not create settings for omitted or all-blank communication', async () => {
    await provisionRukiyeZara(REQUEST, store);
    await provisionRukiyeZara(
      {
        ...REQUEST,
        installation_id: '66666666-6666-4666-8666-666666666666',
        property: {
          external_property_id: '22009',
          name: 'Hill View',
          communication: {
            map_url: null,
            caretaker_phone: '',
            directions: '   ',
          },
        },
      },
      store
    );
    expect(store.communication).toHaveLength(0);
    expect(store.communicationInitializations).toHaveLength(0);
  });

  it('never overwrites host-edited or host-cleared settings on provisioning retry', async () => {
    const request = {
      ...REQUEST,
      property: {
        ...REQUEST.property,
        communication: { map_url: 'https://maps.example/pms' },
      },
    };
    const first = await provisionRukiyeZara(request, store);
    store.communication.set(first.crm_property_id, {
      map_url: 'https://maps.example/host',
    });
    await provisionRukiyeZara(request, store);
    expect(store.communication.get(first.crm_property_id)?.map_url).toBe(
      'https://maps.example/host'
    );

    store.communication.set(first.crm_property_id, { map_url: null });
    await provisionRukiyeZara(request, store);
    expect(store.communication.get(first.crm_property_id)?.map_url).toBeNull();
    expect(store.communicationInitializations).toHaveLength(1);
  });

  it('does not initialize communication later for an already-provisioned property', async () => {
    const first = await provisionRukiyeZara(REQUEST, store);
    await provisionRukiyeZara(
      {
        ...REQUEST,
        property: {
          ...REQUEST.property,
          communication: { map_url: 'https://maps.example/later' },
        },
      },
      store
    );
    expect(store.communication.has(first.crm_property_id)).toBe(false);
    expect(store.communicationInitializations).toHaveLength(0);
  });

  it('removes a newly created property when initialization fails so retry can succeed', async () => {
    const request = {
      ...REQUEST,
      property: {
        ...REQUEST.property,
        communication: { map_url: 'https://maps.example/lakeside' },
      },
    };
    store.failCommunicationInitialization = true;
    await expect(provisionRukiyeZara(request, store)).rejects.toMatchObject({
      code: 'provisioning_failed',
    });
    expect(store.properties).toHaveLength(0);

    const retry = await provisionRukiyeZara(request, store);
    expect(store.communication.get(retry.crm_property_id)?.map_url).toBe(
      'https://maps.example/lakeside'
    );
  });

  it('reuses an existing external identity and its owned workspace', async () => {
    const userId = store.seedUser('mapped@example.com');
    store.seedIdentity(REQUEST.owner.external_user_id, userId);

    const result = await provisionRukiyeZara(REQUEST, store);

    expect(store.createAuthCalls).toBe(0);
    expect(result.workspace_id).toBe('workspace-1');
  });

  it('returns the same workspace, integration, and property IDs on retry', async () => {
    const first = await provisionRukiyeZara(REQUEST, store);
    const second = await provisionRukiyeZara(REQUEST, store);

    expect(second.workspace_id).toBe(first.workspace_id);
    expect(second.integration_id).toBe(first.integration_id);
    expect(second.crm_property_id).toBe(first.crm_property_id);
    expect(store.createAuthCalls).toBe(1);
  });

  it('reuses the workspace and integration for a second property', async () => {
    const first = await provisionRukiyeZara(REQUEST, store);
    const second = await provisionRukiyeZara(
      {
        ...REQUEST,
        installation_id: '66666666-6666-4666-8666-666666666666',
        property: { external_property_id: '22009', name: 'Hill View' },
      },
      store
    );

    expect(second.workspace_id).toBe(first.workspace_id);
    expect(second.integration_id).toBe(first.integration_id);
    expect(second.crm_property_id).not.toBe(first.crm_property_id);
  });

  it('trusts the external identity mapping when the supplied email changes', async () => {
    const userId = store.seedUser('original@example.com');
    store.seedIdentity(
      REQUEST.owner.external_user_id,
      userId,
      'original@example.com'
    );

    const result = await provisionRukiyeZara(
      { ...REQUEST, owner: { ...REQUEST.owner, email: 'changed@example.com' } },
      store
    );

    expect(result.workspace_id).toBe('workspace-1');
    expect(store.createAuthCalls).toBe(0);
    expect(store.usersByEmail.has('changed@example.com')).toBe(false);
  });

  it('requires an authenticated claim when email exists without a mapping', async () => {
    store.seedUser(REQUEST.owner.email);

    await expect(provisionRukiyeZara(REQUEST, store)).rejects.toMatchObject({
      code: 'identity_claim_required',
    });
    expect(store.identities.size).toBe(0);
    expect(store.integrations.size).toBe(0);
  });

  it('does not reset a completed initial sync on reprovisioning', async () => {
    const userId = store.seedUser(REQUEST.owner.email);
    store.seedIdentity(REQUEST.owner.external_user_id, userId);
    const integration = await store.createIntegration({
      accountId: 'workspace-1',
      externalAccountId: REQUEST.external_account_id,
      connectedAt: new Date().toISOString(),
      metadata: {},
    });
    const completed = store.seedCompletedProperty(
      integration.id,
      integration.account_id,
      REQUEST.property.external_property_id
    );

    const result = await provisionRukiyeZara(REQUEST, store);

    expect(result.crm_property_id).toBe(completed.id);
    expect(result.initial_sync_status).toBe('completed');
    expect(
      store.properties.get(
        `${integration.id}:${REQUEST.property.external_property_id}`
      )?.initial_sync_status
    ).toBe('completed');
  });

  it('rejects an external account already attached to an inaccessible workspace', async () => {
    const mappedUser = store.seedUser(REQUEST.owner.email);
    store.seedIdentity(REQUEST.owner.external_user_id, mappedUser);
    const otherUser = store.seedUser('other@example.com');
    await store.createIntegration({
      accountId: store.accountsByOwner.get(otherUser)![0],
      externalAccountId: REQUEST.external_account_id,
      connectedAt: new Date().toISOString(),
      metadata: {},
    });

    await expect(provisionRukiyeZara(REQUEST, store)).rejects.toMatchObject({
      code: 'provisioning_conflict',
    });
  });
});
