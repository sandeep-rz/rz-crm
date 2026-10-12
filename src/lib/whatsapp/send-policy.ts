import { createClient, type SupabaseClient } from '@supabase/supabase-js';
let client: SupabaseClient | undefined;
/** Database allowance is shared across all instances and send sources. A
 * disconnected coexistence number cannot use a previously prepared payload. */
export async function acquireMetaSend(phoneNumberId: string) {
  const db = (client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  ));
  const { data, error } = await db.rpc('acquire_whatsapp_send', {
    p_phone: phoneNumberId,
  });
  if (error || typeof data !== 'number')
    throw new Error('Send availability could not be verified. Retry shortly.');
  return data;
}
