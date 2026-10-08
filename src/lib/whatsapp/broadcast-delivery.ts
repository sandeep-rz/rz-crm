import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MetaApiError } from './meta-api';

// A durable, explicit guard in the existing failure fields. Written before
// Meta, so a crash or timeout never turns an ambiguous send into a safe retry.
export const BROADCAST_DELIVERY_UNCONFIRMED =
  'WhatsApp delivery is unconfirmed. Retry is blocked to prevent duplicates.';

export interface BroadcastRecipientIdentity {
  broadcastId: string;
  recipientId: string;
  contactId: string;
}

export async function claimBroadcastRecipient(
  db: SupabaseClient,
  identity: BroadcastRecipientIdentity
): Promise<boolean> {
  const { data, error } = await db
    .from('broadcast_recipients')
    .update({ status: 'failed', error_message: BROADCAST_DELIVERY_UNCONFIRMED })
    .eq('id', identity.recipientId)
    .eq('broadcast_id', identity.broadcastId)
    .eq('contact_id', identity.contactId)
    .in('status', ['pending', 'failed'])
    .is('whatsapp_message_id', null)
    .or(
      `error_message.is.null,error_message.neq.${BROADCAST_DELIVERY_UNCONFIRMED}`
    )
    .select('id');
  if (error) throw new Error('Could not claim broadcast recipient.');
  return Boolean(data?.length);
}

/** Only a typed 4xx rejection proves a send was rejected, rather than lost. */
export function broadcastSendFailure(error: unknown): string {
  return error instanceof MetaApiError &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500 &&
    error.httpStatus !== 408
    ? 'WhatsApp rejected this template. Check the template and connection.'
    : BROADCAST_DELIVERY_UNCONFIRMED;
}

export async function recordBroadcastRecipientFailure(
  db: SupabaseClient,
  identity: BroadcastRecipientIdentity,
  reason: string,
  claimed = false
): Promise<void> {
  let query = db
    .from('broadcast_recipients')
    .update({ status: 'failed', error_message: reason })
    .eq('id', identity.recipientId)
    .eq('broadcast_id', identity.broadcastId)
    .eq('contact_id', identity.contactId)
    .in('status', ['pending', 'failed'])
    .is('whatsapp_message_id', null);
  query = claimed
    ? query.eq('error_message', BROADCAST_DELIVERY_UNCONFIRMED)
    : query.or(
        `error_message.is.null,error_message.neq.${BROADCAST_DELIVERY_UNCONFIRMED}`
      );
  const { error } = await query;
  if (error) throw new Error('Could not record broadcast recipient failure.');
}
