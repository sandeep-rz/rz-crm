import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import {
  PmsProviderError,
  type PmsIntegrationContext,
  type PmsProvider,
} from '../provider';
import { createPmsProvider } from '../registry';
import {
  PmsReservationSyncError,
  SupabasePmsReservationSyncStore,
  syncPmsReservation,
  type PmsReservationSyncStore,
} from '../reservation-sync';
import { isSupportedRzPmsEvent } from './envelope';
import { schedulePmsAutomationsAfterSync } from '@/lib/automations/pms-scheduler';

export const PMS_WEBHOOK_EVENT_BATCH_SIZE = 10;
export const PMS_WEBHOOK_EVENT_STALE_MS = 15 * 60 * 1000;
export const PMS_WEBHOOK_EVENT_MAX_ATTEMPTS = 5;

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface PmsWebhookEventClaim {
  id: string;
  provider: string;
  externalEventId: string;
  accountId: string;
  integrationId: string;
  propertyId: string;
  eventType: string;
  externalResourceId: string | null;
  occurredAt: string | null;
  processingStartedAt: string;
  attemptCount: number;
}

export interface PmsWebhookEventContext {
  integration: PmsIntegrationContext;
  property: {
    id: string;
    accountId: string;
    integrationId: string;
    externalPropertyId: string;
  };
}

export interface PmsWebhookEventStore {
  claimEvents(input: {
    limit: number;
    now: string;
    staleBefore: string;
  }): Promise<PmsWebhookEventClaim[]>;
  loadContext(
    event: PmsWebhookEventClaim
  ): Promise<PmsWebhookEventContext | null>;
  markProcessed(
    event: PmsWebhookEventClaim,
    processedAt: string
  ): Promise<void>;
  markIgnored(
    event: PmsWebhookEventClaim,
    processedAt: string,
    reason: string
  ): Promise<void>;
  markFailed(
    event: PmsWebhookEventClaim,
    input: {
      error: string;
      retryable: boolean;
      nextAttemptAt: string | null;
    }
  ): Promise<void>;
}

export class PmsWebhookEventProcessingError extends Error {
  constructor(
    public readonly code:
      'invalid_mapping' | 'invalid_resource' | 'reservation_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'PmsWebhookEventProcessingError';
  }
}

class PmsWebhookEventStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmsWebhookEventStoreError';
  }
}

export interface PmsWebhookEventDependencies {
  store?: PmsWebhookEventStore;
  reservationStore?: PmsReservationSyncStore;
  createProvider?: (provider: string) => PmsProvider;
  now?: () => Date;
  scheduleAutomations?: typeof schedulePmsAutomationsAfterSync;
}

export interface PmsWebhookEventResult {
  eventId: string;
  status: 'processed' | 'failed' | 'ignored';
  retryable?: boolean;
}

export interface PmsWebhookEventWorkerResult {
  claimed: number;
  processed: number;
  failed: number;
  ignored: number;
}

function safeFailure(error: unknown): {
  message: string;
  retryable: boolean;
} {
  if (error instanceof PmsWebhookEventProcessingError) {
    return {
      message: `${error.code}: ${error.message}`.slice(0, 500),
      retryable: false,
    };
  }
  if (error instanceof PmsProviderError) {
    const retryable = ['rate_limited', 'upstream_temporary'].includes(
      error.code
    );
    return {
      message: `provider_${error.code}: PMS canonical reservation fetch failed.`,
      retryable,
    };
  }
  if (
    error instanceof PmsReservationSyncError ||
    error instanceof PmsWebhookEventStoreError
  ) {
    return {
      message: 'CRM reservation synchronization failed.',
      retryable: true,
    };
  }
  return { message: 'PMS webhook event processing failed.', retryable: true };
}

function nextAttemptAt(attemptCount: number, now: Date): string | null {
  if (attemptCount >= PMS_WEBHOOK_EVENT_MAX_ATTEMPTS) return null;
  const delay =
    RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)];
  return new Date(now.getTime() + delay).toISOString();
}

export async function processPmsWebhookEvent(
  event: PmsWebhookEventClaim,
  dependencies: PmsWebhookEventDependencies = {}
): Promise<PmsWebhookEventResult> {
  const store = dependencies.store ?? new SupabasePmsWebhookEventStore();
  const now = dependencies.now ?? (() => new Date());

  if (!isSupportedRzPmsEvent(event.eventType)) {
    await store.markIgnored(
      event,
      now().toISOString(),
      'Unsupported PMS webhook event type.'
    );
    return { eventId: event.id, status: 'ignored' };
  }

  try {
    if (!event.externalResourceId?.trim()) {
      throw new PmsWebhookEventProcessingError(
        'invalid_resource',
        'Reservation resource id is missing.'
      );
    }

    const context = await store.loadContext(event);
    if (
      !context ||
      context.integration.integrationId !== event.integrationId ||
      context.integration.accountId !== event.accountId ||
      context.integration.provider !== event.provider ||
      context.property.id !== event.propertyId ||
      context.property.integrationId !== event.integrationId ||
      context.property.accountId !== event.accountId
    ) {
      throw new PmsWebhookEventProcessingError(
        'invalid_mapping',
        'Event integration, account, or property mapping is invalid.'
      );
    }

    const provider = (dependencies.createProvider ?? createPmsProvider)(
      context.integration.provider
    );
    const reservation = await provider.getReservation({
      integration: context.integration,
      externalPropertyId: context.property.externalPropertyId,
      externalReservationId: event.externalResourceId,
    });

    if (
      reservation.externalId !== event.externalResourceId ||
      reservation.externalPropertyId !== context.property.externalPropertyId
    ) {
      throw new PmsWebhookEventProcessingError(
        'reservation_mismatch',
        'Canonical reservation does not match the webhook resource or property.'
      );
    }

    const syncResult = await syncPmsReservation(
      {
        accountId: event.accountId,
        integration: context.integration,
        property: {
          id: context.property.id,
          externalPropertyId: context.property.externalPropertyId,
        },
        reservation,
      },
      dependencies.reservationStore ?? new SupabasePmsReservationSyncStore()
    );

    // This adapter is deliberately outside syncPmsReservation(): initial sync
    // and reconciliation use the same projection function and must not emit
    // historical guest-facing automation occurrences.
    // Test/custom projection stores intentionally do not imply production
    // scheduling. The real worker has no injected reservation store and uses
    // the default durable adapter; unit tests can inject the adapter directly.
    const scheduleAutomations = dependencies.scheduleAutomations ??
      (dependencies.reservationStore ? null : schedulePmsAutomationsAfterSync);
    if (scheduleAutomations) {
      await scheduleAutomations({
        accountId: event.accountId,
        reservationId: syncResult.reservationId,
        webhookEventId: event.id,
        eventType: event.eventType as
          | 'reservation.confirmed'
          | 'reservation.updated'
          | 'reservation.cancelled',
      });
    }

    await store.markProcessed(event, now().toISOString());
    return { eventId: event.id, status: 'processed' };
  } catch (error) {
    const failure = safeFailure(error);
    const retryAt = failure.retryable
      ? nextAttemptAt(event.attemptCount, now())
      : null;
    const retryable = failure.retryable && retryAt !== null;

    try {
      await store.markFailed(event, {
        error: failure.message,
        retryable,
        nextAttemptAt: retryAt,
      });
    } catch {
      // The lease will be recovered as stale. Never leak the original error or
      // credentials through worker logs or responses.
    }

    return { eventId: event.id, status: 'failed', retryable };
  }
}

export async function runPmsWebhookEventWorker(
  dependencies: PmsWebhookEventDependencies & { limit?: number } = {}
): Promise<PmsWebhookEventWorkerResult> {
  const store = dependencies.store ?? new SupabasePmsWebhookEventStore();
  const now = dependencies.now ?? (() => new Date());
  const claimTime = now();
  const claims = await store.claimEvents({
    limit: dependencies.limit ?? PMS_WEBHOOK_EVENT_BATCH_SIZE,
    now: claimTime.toISOString(),
    staleBefore: new Date(
      claimTime.getTime() - PMS_WEBHOOK_EVENT_STALE_MS
    ).toISOString(),
  });
  const reservationStore =
    dependencies.reservationStore ?? new SupabasePmsReservationSyncStore();

  const summary: PmsWebhookEventWorkerResult = {
    claimed: claims.length,
    processed: 0,
    failed: 0,
    ignored: 0,
  };

  for (const claim of claims) {
    try {
      const result = await processPmsWebhookEvent(claim, {
        ...dependencies,
        store,
        reservationStore,
        now,
      });
      summary[result.status]++;
    } catch {
      // A claim/store failure for one event must not prevent later claims from
      // being attempted. Its processing lease will be recovered when stale.
      summary.failed++;
    }
  }

  return summary;
}

export class SupabasePmsWebhookEventStore implements PmsWebhookEventStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async claimEvents(input: {
    limit: number;
    now: string;
    staleBefore: string;
  }): Promise<PmsWebhookEventClaim[]> {
    const { data, error } = await this.admin.rpc('claim_pms_webhook_events', {
      p_limit: input.limit,
      p_now: input.now,
      p_stale_before: input.staleBefore,
    });
    if (error) throw new PmsWebhookEventStoreError('Event claim failed.');

    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: row.event_id as string,
      provider: row.provider as string,
      externalEventId: row.external_event_id as string,
      accountId: row.account_id as string,
      integrationId: row.pms_integration_id as string,
      propertyId: row.pms_property_id as string,
      eventType: row.event_type as string,
      externalResourceId: row.external_resource_id as string | null,
      occurredAt: row.occurred_at as string | null,
      processingStartedAt: row.processing_started_at as string,
      attemptCount: row.attempt_count as number,
    }));
  }

  async loadContext(
    event: PmsWebhookEventClaim
  ): Promise<PmsWebhookEventContext | null> {
    const { data: integration, error: integrationError } = await this.admin
      .from('pms_integrations')
      .select('id, account_id, provider, external_account_id, status')
      .eq('id', event.integrationId)
      .eq('account_id', event.accountId)
      .maybeSingle();
    if (integrationError) {
      throw new PmsWebhookEventStoreError('Integration lookup failed.');
    }
    if (
      !integration ||
      integration.provider !== event.provider ||
      integration.status !== 'connected'
    ) {
      return null;
    }

    const { data: property, error: propertyError } = await this.admin
      .from('pms_properties')
      .select(
        'id, account_id, pms_integration_id, external_property_id, status'
      )
      .eq('id', event.propertyId)
      .eq('account_id', event.accountId)
      .eq('pms_integration_id', event.integrationId)
      .maybeSingle();
    if (propertyError) {
      throw new PmsWebhookEventStoreError('Property lookup failed.');
    }
    if (!property || property.status !== 'active') return null;

    return {
      integration: {
        integrationId: integration.id,
        accountId: integration.account_id,
        provider: integration.provider,
        externalAccountId: integration.external_account_id,
      },
      property: {
        id: property.id,
        accountId: property.account_id,
        integrationId: property.pms_integration_id,
        externalPropertyId: property.external_property_id,
      },
    };
  }

  async markProcessed(event: PmsWebhookEventClaim, processedAt: string) {
    const { error } = await this.admin
      .from('pms_webhook_events')
      .update({
        status: 'processed',
        processing_started_at: null,
        processed_at: processedAt,
        error_message: null,
        retryable: false,
        next_attempt_at: null,
      })
      .eq('id', event.id)
      .eq('status', 'processing')
      .eq('attempt_count', event.attemptCount);
    if (error) throw new PmsWebhookEventStoreError('Completion update failed.');
  }

  async markIgnored(
    event: PmsWebhookEventClaim,
    processedAt: string,
    reason: string
  ) {
    const { error } = await this.admin
      .from('pms_webhook_events')
      .update({
        status: 'ignored',
        processing_started_at: null,
        processed_at: processedAt,
        error_message: reason.slice(0, 500),
        retryable: false,
        next_attempt_at: null,
      })
      .eq('id', event.id)
      .eq('status', 'processing')
      .eq('attempt_count', event.attemptCount);
    if (error) throw new PmsWebhookEventStoreError('Ignored update failed.');
  }

  async markFailed(
    event: PmsWebhookEventClaim,
    input: {
      error: string;
      retryable: boolean;
      nextAttemptAt: string | null;
    }
  ) {
    const { error } = await this.admin
      .from('pms_webhook_events')
      .update({
        status: 'failed',
        processing_started_at: null,
        error_message: input.error.slice(0, 500),
        retryable: input.retryable,
        next_attempt_at: input.nextAttemptAt,
      })
      .eq('id', event.id)
      .eq('status', 'processing')
      .eq('attempt_count', event.attemptCount);
    if (error) throw new PmsWebhookEventStoreError('Failure update failed.');
  }
}
