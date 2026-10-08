import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidE164, normalizePhone } from './phone-utils';

/** Contact identity and destination must agree before preparing or sending. */
export async function validateBroadcastRecipientPhone(
  db: SupabaseClient,
  accountId: string | undefined,
  contactId: string | undefined,
  destination: string
): Promise<{ phone: string; error: null } | { phone: null; error: string }> {
  if (!accountId || !contactId || typeof contactId !== 'string')
    return { phone: null, error: 'Recipient contact is unavailable.' };

  try {
    const { data: contact, error } = await db
      .from('contacts')
      .select('id, account_id, phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (
      error ||
      !contact ||
      contact.id !== contactId ||
      contact.account_id !== accountId
    )
      return { phone: null, error: 'Recipient contact is unavailable.' };

    const phone = normalizePhone(
      typeof contact.phone === 'string' ? contact.phone : ''
    );
    if (!isValidE164(phone))
      return {
        phone: null,
        error: 'Recipient contact has no valid phone number.',
      };
    // Exact normalized equality: suffix matching and trunk-prefix guesses can
    // identify a different destination and must not authorize personalization.
    if (
      typeof destination !== 'string' ||
      normalizePhone(destination) !== phone
    )
      return {
        phone: null,
        error:
          'Recipient phone no longer matches the contact. Refresh the audience.',
      };
    return { phone, error: null };
  } catch {
    return { phone: null, error: 'Recipient contact is unavailable.' };
  }
}
