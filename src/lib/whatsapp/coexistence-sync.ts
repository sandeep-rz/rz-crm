import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from './encryption';
import { requestCoexistenceSync } from './embedded-signup';

/** Intent is committed before the one-time Meta call. An uncertain outcome is
 * never retried automatically, even after a process crash or reconnection. */
export async function resumeCoexistenceSync(
  db: SupabaseClient,
  connectionId: string
) {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select(
      'id,phone_number_id,access_token,status,onboarding_metadata,coexistence_state'
    )
    .eq('id', connectionId)
    .single();
  if (
    error ||
    !config ||
    config.status !== 'connected' ||
    config.onboarding_metadata?.onboarding_mode !== 'coexistence'
  )
    throw new Error('Coexistence connection is unavailable.');
  // Local failures must leave both one-time requests available for recovery.
  let token: string;
  try {
    token = decrypt(config.access_token);
    if (!token.trim() || !/^\d{1,30}$/.test(config.phone_number_id))
      throw new Error();
  } catch {
    throw new Error(
      'Coexistence credentials could not be validated. No synchronization request was reserved.'
    );
  }
  let accepted = !['smb_app_state_sync', 'history'].some(
    (type) => config.coexistence_state?.[type]?.state === 'unconfirmed'
  );
  for (const type of ['smb_app_state_sync', 'history'] as const) {
    const { data: claimed, error: claimError } = await db.rpc(
      'begin_whatsapp_coexistence_sync',
      { p_connection: connectionId, p_type: type }
    );
    if (claimError) throw new Error('Could not reserve synchronization.');
    if (!claimed) continue;
    try {
      const requestId = await requestCoexistenceSync(
        config.phone_number_id,
        token,
        type
      );
      const { error: saveError } = await db.rpc(
        'accept_whatsapp_coexistence_sync',
        { p_connection: connectionId, p_type: type, p_request_id: requestId }
      );
      if (saveError) throw new Error('Could not save sync acceptance.');
    } catch {
      accepted = false;
      // Process the other independent sync type; leave unknown intent visible.
      // No reset-to-pending on timeouts, transport, 5xx or post-acceptance failure.
    }
  }
  return accepted;
}
