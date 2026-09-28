import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import { createPmsProvider } from './registry';
import { PmsProviderError, type PmsIntegrationContext } from './provider';
import {
  syncPmsReservation,
  SupabasePmsReservationSyncStore,
  type PmsReservationSyncStore,
} from './reservation-sync';
import { type InitialSyncStatus } from './types';

export const PMS_INITIAL_SYNC_PAGE_SIZE = 200;
export const PMS_INITIAL_SYNC_STALE_MS = 15 * 60 * 1000;

export interface InitialSyncClaim {
  propertyId: string;
  accountId: string;
  integration: PmsIntegrationContext;
  externalPropertyId: string;
}

export interface InitialSyncStore {
  claimProperty(input: {
    propertyId: string;
    now: string;
    staleBefore: string;
    force: boolean;
  }): Promise<InitialSyncClaim | null>;
  markCompleted(input: {
    propertyId: string;
    completedAt: string;
    lastSyncedAt: string;
  }): Promise<void>;
  markFailed(input: {
    propertyId: string;
    failedAt: string;
    error: string;
  }): Promise<void>;
}

export interface InitialSyncDependencies {
  store?: InitialSyncStore;
  reservationStore?: PmsReservationSyncStore;
  now?: () => Date;
  createProvider?: typeof createPmsProvider;
  force?: boolean;
}

export interface InitialSyncResult {
  propertyId: string;
  status: 'completed' | 'already_running' | 'failed';
  reservationsProcessed: number;
  contactsCreated: number;
  contactsReused: number;
}

function safeFailure(error: unknown): string {
  if (error instanceof PmsProviderError)
    return `${error.code}: ${error.message}`.slice(0, 500);
  if (error instanceof Error)
    return error.message.replace(/\s+/g, ' ').slice(0, 500);
  return 'Initial PMS reservation sync failed.';
}

export async function runInitialPmsPropertySync(
  propertyId: string,
  options: InitialSyncDependencies = {}
): Promise<InitialSyncResult> {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? new SupabaseInitialSyncStore();
  const startedAt = now();
  const claim = await store.claimProperty({
    propertyId,
    now: startedAt.toISOString(),
    staleBefore: new Date(
      startedAt.getTime() - PMS_INITIAL_SYNC_STALE_MS
    ).toISOString(),
    force: options.force === true,
  });
  if (!claim) {
    return {
      propertyId,
      status: 'already_running',
      reservationsProcessed: 0,
      contactsCreated: 0,
      contactsReused: 0,
    };
  }

  let reservationsProcessed = 0;
  let contactsCreated = 0;
  let contactsReused = 0;
  try {
    const provider = (options.createProvider ?? createPmsProvider)(
      claim.integration.provider
    );
    const reservationStore =
      options.reservationStore ?? new SupabasePmsReservationSyncStore();
    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    while (true) {
      const page = await provider.listReservations({
        integration: claim.integration,
        externalPropertyId: claim.externalPropertyId,
        limit: PMS_INITIAL_SYNC_PAGE_SIZE,
        cursor,
      });
      for (const reservation of page.items) {
        const result = await syncPmsReservation(
          {
            accountId: claim.accountId,
            integration: claim.integration,
            property: {
              id: claim.propertyId,
              externalPropertyId: claim.externalPropertyId,
            },
            reservation,
          },
          reservationStore
        );
        reservationsProcessed++;
        if (result.contactCreated) contactsCreated++;
        else if (result.contactId) contactsReused++;
      }
      if (!page.hasMore) break;
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        throw new Error('PMS pagination did not advance safely.');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    const completedAt = now().toISOString();
    await store.markCompleted({
      propertyId,
      completedAt,
      lastSyncedAt: completedAt,
    });
    return {
      propertyId,
      status: 'completed',
      reservationsProcessed,
      contactsCreated,
      contactsReused,
    };
  } catch (error) {
    await store.markFailed({
      propertyId,
      failedAt: now().toISOString(),
      error: safeFailure(error),
    });
    return {
      propertyId,
      status: 'failed',
      reservationsProcessed,
      contactsCreated,
      contactsReused,
    };
  }
}

export class SupabaseInitialSyncStore implements InitialSyncStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async claimProperty(input: {
    propertyId: string;
    now: string;
    staleBefore: string;
    force: boolean;
  }): Promise<InitialSyncClaim | null> {
    const { data: property, error: propertyError } = await this.admin
      .from('pms_properties')
      .select(
        'id, account_id, pms_integration_id, external_property_id, initial_sync_status, initial_sync_started_at'
      )
      .eq('id', input.propertyId)
      .eq('status', 'active')
      .maybeSingle();
    if (propertyError) throw new Error('PMS property claim lookup failed.');
    if (!property) return null;

    const status = property.initial_sync_status as InitialSyncStatus;
    const stale =
      status === 'syncing' &&
      !!property.initial_sync_started_at &&
      property.initial_sync_started_at < input.staleBefore;
    const claimable =
      input.force || status === 'pending' || status === 'failed' || stale;
    if (!claimable) return null;

    let claimQuery = this.admin
      .from('pms_properties')
      .update({
        initial_sync_status: 'syncing',
        initial_sync_started_at: input.now,
        last_sync_error: null,
      })
      .eq('id', input.propertyId);
    if (!input.force) {
      if (stale) {
        claimQuery = claimQuery
          .eq('initial_sync_status', 'syncing')
          .lt('initial_sync_started_at', input.staleBefore);
      } else {
        claimQuery = claimQuery.eq('initial_sync_status', status);
      }
    }
    const { data: claimed, error: claimError } = await claimQuery
      .select('id, account_id, pms_integration_id, external_property_id')
      .maybeSingle();
    if (claimError) throw new Error('PMS property claim failed.');
    if (!claimed) return null;

    const { data: integration, error: integrationError } = await this.admin
      .from('pms_integrations')
      .select('id, account_id, provider, external_account_id, status')
      .eq('id', claimed.pms_integration_id)
      .eq('account_id', claimed.account_id)
      .maybeSingle();
    if (
      integrationError ||
      !integration ||
      integration.status !== 'connected'
    ) {
      await this.markFailed({
        propertyId: input.propertyId,
        failedAt: input.now,
        error: 'PMS integration is not connected.',
      });
      return null;
    }
    return {
      propertyId: claimed.id,
      accountId: claimed.account_id,
      externalPropertyId: claimed.external_property_id,
      integration: {
        integrationId: integration.id,
        accountId: integration.account_id,
        provider: integration.provider,
        externalAccountId: integration.external_account_id,
      },
    };
  }

  async markCompleted(input: {
    propertyId: string;
    completedAt: string;
    lastSyncedAt: string;
  }) {
    const { error } = await this.admin
      .from('pms_properties')
      .update({
        initial_sync_status: 'completed',
        initial_sync_completed_at: input.completedAt,
        last_synced_at: input.lastSyncedAt,
        last_sync_error: null,
      })
      .eq('id', input.propertyId)
      .eq('initial_sync_status', 'syncing');
    if (error) throw new Error('PMS property completion update failed.');
  }

  async markFailed(input: {
    propertyId: string;
    failedAt: string;
    error: string;
  }) {
    const { error } = await this.admin
      .from('pms_properties')
      .update({
        initial_sync_status: 'failed',
        last_sync_error: input.error,
      })
      .eq('id', input.propertyId)
      .eq('initial_sync_status', 'syncing');
    if (error) throw new Error('PMS property failure update failed.');
  }
}
