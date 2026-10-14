import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import {
  captureCoexistenceWebhook,
  drainCoexistenceWebhook,
} from './coexistence-webhook';
import { resumeCoexistenceSync } from './coexistence-sync';

export type DeliveryReceipt = { id: number; lease: string };
/** A persisted started stage has an unknown external outcome after interruption.
 * Preserve it for review instead of risking duplicate replies or automation. */
export async function deliveryStage<T>(
  db: SupabaseClient,
  receipt: DeliveryReceipt | undefined,
  stage: string,
  action: () => Promise<T>
): Promise<T> {
  if (!receipt) return action();
  const args = { p_id: receipt.id, p_lease: receipt.lease, p_stage: stage };
  const { data, error } = await db.rpc('whatsapp_delivery_stage', args);
  if (error) throw new Error('stage_claim_failed');
  if (data?.state === 'done') return data.result as T;
  if (data?.state !== 'claimed')
    throw new Error('external_stage_outcome_unknown');
  const result = await action();
  const { error: saveError } = await db.rpc('whatsapp_delivery_stage', {
    ...args,
    p_result: result ?? {},
  });
  if (saveError) throw new Error('stage_result_unconfirmed');
  return result;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Split signed envelopes into independently recoverable receipts. A normal
 * message's provider identity stays stable across different retry envelopes. */
export async function captureWhatsAppDelivery(
  db: SupabaseClient,
  input: unknown
) {
  const body = object(input);
  const deliveries: { key: string; payload: unknown }[] = [];
  if (!Array.isArray(body.entry)) throw new Error('Invalid webhook envelope');
  for (const rawEntry of array(body.entry))
    for (const rawChange of array(object(rawEntry).changes)) {
      const entry = object(rawEntry),
        change = object(rawChange);
      const value = object(change.value);
      const fragments: { value: Record<string, unknown>; key?: string }[] =
        change.field === 'messages' && array(value.messages).length
          ? array(value.messages).map((message) => ({
              value: {
                ...value,
                messages: [message],
                statuses: undefined,
                contacts: array(value.contacts).length
                  ? [
                      array(value.contacts).find((raw) => {
                        const c = object(raw),
                          m = object(message);
                        return (
                          (typeof m.from === 'string' && c.wa_id === m.from) ||
                          (typeof m.from_user_id === 'string' &&
                            c.user_id === m.from_user_id)
                        );
                      }) ??
                        (array(value.contacts).length === 1
                          ? array(value.contacts)[0]
                          : undefined),
                    ]
                  : undefined,
              },
              key: `message:${object(message).id}`,
            }))
          : change.field === 'messages' && array(value.statuses).length
            ? []
            : [{ value, key: undefined }];
      if (change.field === 'messages')
        for (const status of array(value.statuses)) {
          fragments.push({
            value: {
              ...value,
              messages: undefined,
              contacts: undefined,
              statuses: [status],
            },
            key: `status:${JSON.stringify(status)}`,
          });
        }
      for (const fragment of fragments) {
        const payload = {
          ...body,
          entry: [
            { ...entry, changes: [{ ...change, value: fragment.value }] },
          ],
        };
        const key = createHash('sha256')
          .update(
            fragment.key
              ? JSON.stringify([
                  entry.id,
                  change.field,
                  object(value.metadata).phone_number_id,
                  fragment.key,
                ])
              : JSON.stringify(payload)
          )
          .digest('hex');
        deliveries.push({ key, payload });
        if (deliveries.length > 1000)
          throw new Error('delivery_batch_too_large');
      }
    }
  if (deliveries.length) {
    const { error } = await db.rpc('capture_whatsapp_deliveries', {
      p_deliveries: deliveries,
    });
    if (error) throw new Error('delivery_capture_failed');
  }
  // Preserve SQL-only coexistence recovery before ACK. Captured lifecycle
  // events pause prepared sends even if the TypeScript worker is interrupted.
  // An unresolved route is safely retained in the raw receipt for later replay.
  try {
    await captureCoexistenceWebhook(db, body);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== 'coexistence_routing_unresolved'
    )
      throw error;
  }
}
const safeFailureReasons = new Set([
  'coexistence_routing_unresolved',
  'connection_unresolved',
  'connection_lookup_failed',
  'connection_asset_mismatch',
  'invalid_inbound_identity',
  'contact_write_failed',
  'conversation_write_failed',
  'conversation_deletion_lookup_failed',
  'message_write_failed',
  'message_promotion_failed',
  'message_replay_lookup_failed',
  'inbox_write_failed',
  'inbound_intent_lookup_failed',
  'inbound_intent_write_failed',
  'stage_claim_failed',
  'external_stage_outcome_unknown',
  'stage_result_unconfirmed',
  'status_write_failed',
  'status_unmatched',
  'template_write_failed',
]);
/** Cron is the recovery trigger; after() only lowers latency. */
export async function runWhatsAppWorker(db: SupabaseClient) {
  const started = Date.now();
  let processed = 0,
    failed = 0;
  const { processWebhook } = await import('./webhook-processor');
  while (Date.now() - started < 40_000 && processed + failed < 20) {
    const lease = randomUUID();
    const { data, error } = await db.rpc('claim_whatsapp_deliveries', {
      p_limit: 1,
      p_lease: lease,
    });
    if (error) throw new Error('delivery_claim_failed');
    const receipt = data?.[0];
    if (!receipt) break;
    let failure: string | null = null;
    try {
      await captureCoexistenceWebhook(db, receipt.payload);
      // Apply lifecycle before live dispatch / prepared sends.
      await drainCoexistenceWebhook(db, 1, 1);
      await processWebhook(receipt.payload, { id: receipt.id, lease });
      processed++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      failure = safeFailureReasons.has(reason)
        ? reason
        : 'delivery_processing_failed';
      console.warn('[whatsapp] delivery deferred', {
        receipt_id: receipt.id,
        reason: failure,
      });
      failed++;
    }
    const { error: finishError } = await db.rpc('finish_whatsapp_delivery', {
      p_id: receipt.id,
      p_lease: lease,
      p_error: failure,
    });
    if (finishError) throw new Error('delivery_finish_failed');
  }
  await drainCoexistenceWebhook(db, 5);
  const { data: pending, error } = await db.rpc(
    'pending_whatsapp_coexistence_sync'
  );
  if (error) throw new Error('sync_discovery_failed');
  for (const id of pending ?? []) {
    if (Date.now() - started > 45_000) break;
    try {
      await resumeCoexistenceSync(db, id, started + 55_000);
    } catch {
      failed++;
    }
  }
  return { processed, failed };
}
