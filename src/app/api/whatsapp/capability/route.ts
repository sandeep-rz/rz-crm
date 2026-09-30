import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { capabilityFromConnectionCount } from '@/lib/whatsapp/capability';

/**
 * A credential-free, account-scoped capability check for client UI gates.
 * `status = connected` is the existing connection lifecycle contract; the
 * phone number identity guard prevents a malformed legacy row from unlocking
 * WhatsApp-only surfaces. Tokens and connection rows never leave the server.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { count, error } = await supabase
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('status', 'connected')
      .neq('phone_number_id', '');

    if (error) {
      console.error('[whatsapp/capability] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load WhatsApp capability' },
        { status: 500 }
      );
    }

    return NextResponse.json(capabilityFromConnectionCount(count), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
