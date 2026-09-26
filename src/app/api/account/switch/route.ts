import { NextResponse } from 'next/server';
import type { PostgrestError } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function rpcErrorToResponse(error: PostgrestError): NextResponse {
  if (error.code === '42501') {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  console.error('[POST /api/account/switch] RPC error:', error);
  return NextResponse.json(
    { error: 'Failed to switch workspace' },
    { status: 500 }
  );
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    accountId?: unknown;
  } | null;
  if (!isUuid(body?.accountId)) {
    return NextResponse.json(
      { error: "'accountId' must be a valid UUID" },
      { status: 400 }
    );
  }

  // switch_account uses auth.uid() and account_members internally. Never
  // accept or forward a client-supplied user id here.
  const { data, error } = await supabase.rpc('switch_account', {
    p_account_id: body.accountId,
  });
  if (error) return rpcErrorToResponse(error);

  return NextResponse.json({ ok: true, accountId: data });
}
