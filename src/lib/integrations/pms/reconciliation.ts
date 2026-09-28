import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';

import {
  PmsProviderError,
  type PmsIntegrationContext,
  type PmsProvider,
} from './provider';
import { createPmsProvider } from './registry';
import {
  PmsReservationSyncError,
  SupabasePmsReservationSyncStore,
  syncPmsReservation,
  type PmsReservationSyncStore,
} from './reservation-sync';

export const PMS_RECONCILIATION_BATCH_SIZE = 10;
export const PMS_RECONCILIATION_PAGE_SIZE = 200;
export const PMS_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PMS_RECONCILIATION_STALE_MS = 15 * 60 * 1000;

export interface PmsReconciliationClaim {
  propertyId: string;
  accountId: string;
  externalPropertyId: string;
  lastReconciledAt: string | null;
  integration: PmsIntegrationContext;
  processingStartedAt: string;
  attemptCount: number;
}

export interface PmsReconciliationStore {
  claimProperties(input: {
    limit: number;
    now: string;
    dueBefore: string;
    staleBefore: string;
  }): Promise<PmsReconciliationClaim[]>;
  markCompleted(
    claim: PmsReconciliationClaim,
    completedAt: string
  ): Promise<void>;
  markFailed(
    claim: PmsReconciliationClaim,
    input: { error: string; nextAttemptAt: string }
  ): Promise<void>;
}

export interface PmsReconciliationDependencies {
  store?: PmsReconciliationStore;
  reservationStore?: PmsReservationSyncStore;
  createProvider?: (provider: string) => PmsProvider;
  now?: () => Date;
}

export interface PmsPropertyReconciliationResult {
  propertyId: string;
  status: 'completed' | 'failed';
  reservationsProcessed: number;
}

export interface PmsReconciliationWorkerResult {
  claimed: number;
  completed: number;
  failed: number;
  reservationsProcessed: number;
}

class PmsReconciliationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmsReconciliationStoreError';
  }
}

function safeFailure(error: unknown): string {
  if (error instanceof PmsProviderError) {
    return `provider_${error.code}: PMS reservation listing failed.`;
  }
  if (error instanceof PmsReservationSyncError) {
    return 'CRM reservation synchronization failed.';
  }
  if (error instanceof PmsReconciliationStoreError) {
    return 'PMS reconciliation state update failed.';
  }
  if (error instanceof Error && /pagination/i.test(error.message)) {
    return 'PMS reservation pagination did not advance safely.';
  }
  return 'PMS reservation reconciliation failed.';
}

export async function reconcilePmsProperty(
  claim: PmsReconciliationClaim,
  dependencies: PmsReconciliationDependencies = {}
): Promise<PmsPropertyReconciliationResult> {
  const store = dependencies.store ?? new SupabasePmsReconciliationStore();
  const reservationStore =
    dependencies.reservationStore ?? new SupabasePmsReservationSyncStore();
  const now = dependencies.now ?? (() => new Date());
  let reservationsProcessed = 0;

  try {
    const provider = (dependencies.createProvider ?? createPmsProvider)(
      claim.integration.provider
    );
    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    while (true) {
      const page = await provider.listReservations({
        integration: claim.integration,
        externalPropertyId: claim.externalPropertyId,
        limit: PMS_RECONCILIATION_PAGE_SIZE,
        cursor,
        // The PMS contract is inclusive (>=). Re-reading the boundary row is
        // intentional and safe because syncPmsReservation is idempotent.
        updatedSince: claim.lastReconciledAt,
      });

      for (const reservation of page.items) {
        await syncPmsReservation(
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
      }

      if (!page.hasMore) break;
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        throw new Error('PMS pagination did not advance safely.');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    await store.markCompleted(claim, now().toISOString());
    return {
      propertyId: claim.propertyId,
      status: 'completed',
      reservationsProcessed,
    };
  } catch (error) {
    const failedAt = now();
    try {
      await store.markFailed(claim, {
        error: safeFailure(error),
        nextAttemptAt: new Date(
          failedAt.getTime() + PMS_RECONCILIATION_INTERVAL_MS
        ).toISOString(),
      });
    } catch {
      // A lost state-update response leaves the lease recoverable after the
      // stale threshold. Never leak provider credentials through the route.
    }
    return {
      propertyId: claim.propertyId,
      status: 'failed',
      reservationsProcessed,
    };
  }
}

export async function runPmsReservationReconciliationWorker(
  dependencies: PmsReconciliationDependencies & { limit?: number } = {}
): Promise<PmsReconciliationWorkerResult> {
  const store = dependencies.store ?? new SupabasePmsReconciliationStore();
  const reservationStore =
    dependencies.reservationStore ?? new SupabasePmsReservationSyncStore();
  const now = dependencies.now ?? (() => new Date());
  const claimTime = now();
  const claims = await store.claimProperties({
    limit: dependencies.limit ?? PMS_RECONCILIATION_BATCH_SIZE,
    now: claimTime.toISOString(),
    dueBefore: new Date(
      claimTime.getTime() - PMS_RECONCILIATION_INTERVAL_MS
    ).toISOString(),
    staleBefore: new Date(
      claimTime.getTime() - PMS_RECONCILIATION_STALE_MS
    ).toISOString(),
  });

  const summary: PmsReconciliationWorkerResult = {
    claimed: claims.length,
    completed: 0,
    failed: 0,
    reservationsProcessed: 0,
  };

  for (const claim of claims) {
    try {
      const result = await reconcilePmsProperty(claim, {
        ...dependencies,
        store,
        reservationStore,
        now,
      });
      summary[result.status]++;
      summary.reservationsProcessed += result.reservationsProcessed;
    } catch {
      // A single claim must not prevent later properties in the bounded batch
      // from running. Its processing lease remains recoverable when stale.
      summary.failed++;
    }
  }

  return summary;
}

export class SupabasePmsReconciliationStore implements PmsReconciliationStore {
  constructor(private readonly admin: SupabaseClient = supabaseAdmin()) {}

  async claimProperties(input: {
    limit: number;
    now: string;
    dueBefore: string;
    staleBefore: string;
  }): Promise<PmsReconciliationClaim[]> {
    const { data, error } = await this.admin.rpc(
      'claim_pms_reconciliation_properties',
      {
        p_limit: input.limit,
        p_now: input.now,
        p_due_before: input.dueBefore,
        p_stale_before: input.staleBefore,
      }
    );
    if (error) {
      throw new PmsReconciliationStoreError('PMS reconciliation claim failed.');
    }

    const claimedRows = (data ?? []) as Array<Record<string, unknown>>;
    if (claimedRows.length === 0) return [];

    const { data: properties, error: propertyError } = await this.admin
      .from('pms_properties')
      .select('id, last_reconciled_at')
      .in(
        'id',
        claimedRows.map((row) => row.property_id as string)
      );
    if (propertyError || properties?.length !== claimedRows.length) {
      throw new PmsReconciliationStoreError(
        'PMS reconciliation watermark lookup failed.'
      );
    }
    const watermarks = new Map(
      properties.map((property) => [
        property.id as string,
        property.last_reconciled_at as string | null,
      ])
    );

    return claimedRows.map((row) => ({
      propertyId: row.property_id as string,
      accountId: row.account_id as string,
      externalPropertyId: row.external_property_id as string,
      lastReconciledAt: watermarks.get(row.property_id as string) ?? null,
      integration: {
        integrationId: row.pms_integration_id as string,
        accountId: row.account_id as string,
        provider: row.provider as string,
        externalAccountId: row.external_account_id as string,
      },
      processingStartedAt: row.reconciliation_started_at as string,
      attemptCount: row.reconciliation_attempt_count as number,
    }));
  }

  async markCompleted(
    claim: PmsReconciliationClaim,
    completedAt: string
  ): Promise<void> {
    const { data, error } = await this.admin
      .from('pms_properties')
      .update({
        reconciliation_status: 'completed',
        reconciliation_started_at: null,
        last_reconciled_at: completedAt,
        last_reconciliation_error: null,
        reconciliation_next_attempt_at: null,
      })
      .eq('id', claim.propertyId)
      .eq('account_id', claim.accountId)
      .eq('pms_integration_id', claim.integration.integrationId)
      .eq('status', 'active')
      .eq('reconciliation_status', 'processing')
      .eq('reconciliation_attempt_count', claim.attemptCount)
      .select('id')
      .maybeSingle();
    if (error || !data) {
      throw new PmsReconciliationStoreError(
        'PMS reconciliation completion update failed.'
      );
    }
  }

  async markFailed(
    claim: PmsReconciliationClaim,
    input: { error: string; nextAttemptAt: string }
  ): Promise<void> {
    const { data, error } = await this.admin
      .from('pms_properties')
      .update({
        reconciliation_status: 'failed',
        reconciliation_started_at: null,
        last_reconciliation_error: input.error.slice(0, 500),
        reconciliation_next_attempt_at: input.nextAttemptAt,
      })
      .eq('id', claim.propertyId)
      .eq('account_id', claim.accountId)
      .eq('pms_integration_id', claim.integration.integrationId)
      .eq('reconciliation_status', 'processing')
      .eq('reconciliation_attempt_count', claim.attemptCount)
      .select('id')
      .maybeSingle();
    if (error || !data) {
      throw new PmsReconciliationStoreError(
        'PMS reconciliation failure update failed.'
      );
    }
  }
}
