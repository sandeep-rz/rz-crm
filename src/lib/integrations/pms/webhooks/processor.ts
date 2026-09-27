import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import { RUKIYE_ZARA_PROVIDER } from '../types';
import type { RzPmsWebhookEnvelope } from './envelope';

export interface PmsPropertyMapping {
  id: string;
  accountId: string;
  integrationId: string;
  propertyStatus: string;
  integrationProvider: string;
  integrationStatus: string;
}

export interface WebhookReceiptInput {
  externalEventId: string;
  accountId: string;
  integrationId: string;
  propertyId: string;
  eventType: string;
  externalResourceId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface PmsWebhookStore {
  findPropertyMappings(
    externalPropertyId: string
  ): Promise<PmsPropertyMapping[]>;
  insertReceipt(input: WebhookReceiptInput): Promise<'created' | 'duplicate'>;
}

export type PmsWebhookProcessingErrorCode =
  'property_not_connected' | 'webhook_processing_failed';

export class PmsWebhookProcessingError extends Error {
  constructor(public readonly code: PmsWebhookProcessingErrorCode) {
    super(code);
    this.name = 'PmsWebhookProcessingError';
  }
}

function storageFailure(): never {
  throw new PmsWebhookProcessingError('webhook_processing_failed');
}

export class SupabasePmsWebhookStore implements PmsWebhookStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async findPropertyMappings(
    externalPropertyId: string
  ): Promise<PmsPropertyMapping[]> {
    const { data: properties, error: propertyError } = await this.admin
      .from('pms_properties')
      .select('id, account_id, pms_integration_id, status')
      .eq('external_property_id', externalPropertyId);
    if (propertyError) storageFailure();
    if (!properties?.length) return [];

    const integrationIds = [
      ...new Set(properties.map((property) => property.pms_integration_id)),
    ];
    const { data: integrations, error: integrationError } = await this.admin
      .from('pms_integrations')
      .select('id, provider, status')
      .in('id', integrationIds);
    if (integrationError) storageFailure();

    const integrationsById = new Map(
      (integrations ?? []).map((integration) => [integration.id, integration])
    );

    return properties.flatMap((property) => {
      const integration = integrationsById.get(property.pms_integration_id);
      if (!integration) return [];
      return [
        {
          id: property.id,
          accountId: property.account_id,
          integrationId: property.pms_integration_id,
          propertyStatus: property.status,
          integrationProvider: integration.provider,
          integrationStatus: integration.status,
        },
      ];
    });
  }

  async insertReceipt(
    input: WebhookReceiptInput
  ): Promise<'created' | 'duplicate'> {
    const { error } = await this.admin.from('pms_webhook_events').insert({
      provider: RUKIYE_ZARA_PROVIDER,
      external_event_id: input.externalEventId,
      account_id: input.accountId,
      pms_integration_id: input.integrationId,
      pms_property_id: input.propertyId,
      event_type: input.eventType,
      external_resource_id: input.externalResourceId,
      occurred_at: input.occurredAt,
      status: 'received',
      payload: input.payload,
    });

    if (error?.code === '23505') return 'duplicate';
    if (error) storageFailure();
    return 'created';
  }
}

export interface ProcessPmsWebhookResult {
  duplicate: boolean;
  accountId: string;
  integrationId: string;
  propertyId: string;
}

export async function processRzPmsWebhookEvent(
  event: RzPmsWebhookEnvelope,
  store: PmsWebhookStore = new SupabasePmsWebhookStore()
): Promise<ProcessPmsWebhookResult> {
  try {
    const mappings = await store.findPropertyMappings(event.property_id);
    const usable = mappings.filter(
      (mapping) =>
        mapping.integrationProvider === RUKIYE_ZARA_PROVIDER &&
        mapping.integrationStatus === 'connected' &&
        mapping.propertyStatus === 'active'
    );

    if (usable.length !== 1) {
      throw new PmsWebhookProcessingError('property_not_connected');
    }

    const mapping = usable[0];
    const receipt = await store.insertReceipt({
      externalEventId: event.id,
      accountId: mapping.accountId,
      integrationId: mapping.integrationId,
      propertyId: mapping.id,
      eventType: event.type,
      externalResourceId: event.resource.id,
      occurredAt: event.occurred_at,
      payload: {
        canonical_sync_required: true,
        api_version: event.api_version,
        resource: event.resource,
        source: event.source,
        data: event.data,
      },
    });

    return {
      duplicate: receipt === 'duplicate',
      accountId: mapping.accountId,
      integrationId: mapping.integrationId,
      propertyId: mapping.id,
    };
  } catch (error) {
    if (error instanceof PmsWebhookProcessingError) throw error;
    throw new PmsWebhookProcessingError('webhook_processing_failed');
  }
}
