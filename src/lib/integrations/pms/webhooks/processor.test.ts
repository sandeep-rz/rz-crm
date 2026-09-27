import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { RzPmsWebhookEnvelope } from './envelope';
import {
  type PmsPropertyMapping,
  type PmsWebhookStore,
  type WebhookReceiptInput,
  SupabasePmsWebhookStore,
  processRzPmsWebhookEvent,
} from './processor';

const EVENT: RzPmsWebhookEnvelope = {
  id: 'evt-rz-1001',
  type: 'reservation.confirmed',
  api_version: '2026-09-01',
  occurred_at: '2026-09-27T12:00:00.000Z',
  property_id: '22008',
  resource: { type: 'reservation', id: 'RZ-RES-9001' },
  source: null,
  data: { status: 'confirmed' },
};

const MAPPING: PmsPropertyMapping = {
  id: 'crm-property-1',
  accountId: 'resolved-workspace-1',
  integrationId: 'integration-1',
  propertyStatus: 'active',
  integrationProvider: 'rukiye_zara',
  integrationStatus: 'connected',
};

class MemoryWebhookStore implements PmsWebhookStore {
  mappings: PmsPropertyMapping[] = [MAPPING];
  receipts = new Map<string, WebhookReceiptInput>();
  writes: WebhookReceiptInput[] = [];

  async findPropertyMappings(externalPropertyId: string) {
    return externalPropertyId === EVENT.property_id ? this.mappings : [];
  }

  async insertReceipt(input: WebhookReceiptInput) {
    const key = `rukiye_zara:${input.externalEventId}`;
    if (this.receipts.has(key)) return 'duplicate' as const;

    // Set synchronously before yielding, mirroring a database unique index:
    // only one concurrent insert can claim the idempotency key.
    this.receipts.set(key, input);
    this.writes.push(input);
    await Promise.resolve();
    return 'created' as const;
  }
}

let store: MemoryWebhookStore;

beforeEach(() => {
  store = new MemoryWebhookStore();
});

describe('RZ PMS webhook processing', () => {
  it('uses the resolved property mapping as the CRM account boundary', async () => {
    const event: RzPmsWebhookEnvelope = {
      ...EVENT,
      data: {
        account_id: 'attacker-workspace',
        workspace_id: 'attacker-workspace',
        status: 'confirmed',
      },
    };

    const result = await processRzPmsWebhookEvent(event, store);

    expect(result.accountId).toBe(MAPPING.accountId);
    expect(result.integrationId).toBe(MAPPING.integrationId);
    expect(result.propertyId).toBe(MAPPING.id);
    expect(store.writes[0]).toMatchObject({
      accountId: MAPPING.accountId,
      integrationId: MAPPING.integrationId,
      propertyId: MAPPING.id,
      externalResourceId: EVENT.resource.id,
      payload: {
        canonical_sync_required: true,
        api_version: EVENT.api_version,
        resource: EVENT.resource,
        source: EVENT.source,
        data: event.data,
      },
    });
  });

  it('allows exactly one concurrent receipt insert for an event id', async () => {
    const results = await Promise.all([
      processRzPmsWebhookEvent(EVENT, store),
      processRzPmsWebhookEvent(EVENT, store),
    ]);

    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(store.writes).toHaveLength(1);
  });

  it('treats the database unique-constraint violation as a duplicate', async () => {
    const admin = {
      from: () => ({
        insert: async () => ({ error: { code: '23505' } }),
      }),
    } as unknown as SupabaseClient;
    const databaseStore = new SupabasePmsWebhookStore(admin);

    await expect(
      databaseStore.insertReceipt({
        externalEventId: EVENT.id,
        accountId: MAPPING.accountId,
        integrationId: MAPPING.integrationId,
        propertyId: MAPPING.id,
        eventType: EVENT.type,
        externalResourceId: EVENT.resource.id,
        occurredAt: EVENT.occurred_at,
        payload: { canonical_sync_required: true },
      })
    ).resolves.toBe('duplicate');
  });

  it('rejects a missing, inactive, disconnected, or ambiguous property mapping', async () => {
    store.mappings = [];
    await expect(processRzPmsWebhookEvent(EVENT, store)).rejects.toMatchObject({
      code: 'property_not_connected',
    });

    store.mappings = [{ ...MAPPING, propertyStatus: 'inactive' }];
    await expect(processRzPmsWebhookEvent(EVENT, store)).rejects.toMatchObject({
      code: 'property_not_connected',
    });

    store.mappings = [{ ...MAPPING, integrationStatus: 'suspended' }];
    await expect(processRzPmsWebhookEvent(EVENT, store)).rejects.toMatchObject({
      code: 'property_not_connected',
    });

    store.mappings = [MAPPING, { ...MAPPING, id: 'crm-property-2' }];
    await expect(processRzPmsWebhookEvent(EVENT, store)).rejects.toMatchObject({
      code: 'property_not_connected',
    });
  });
});
