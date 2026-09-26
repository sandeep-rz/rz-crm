import { NextResponse } from 'next/server';
import type { PostgrestError } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';

const MAX_WORKSPACE_NAME_LENGTH = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rpcErrorToResponse(error: PostgrestError): NextResponse {
  if (error.code === '42501') {
    return NextResponse.json(
      { error: 'You do not have permission to create a workspace' },
      { status: 403 }
    );
  }
  if (error.code === '22023') {
    return NextResponse.json(
      { error: 'Invalid workspace name' },
      { status: 400 }
    );
  }

  console.error('[POST /api/account/create] RPC error:', error);
  return NextResponse.json(
    { error: 'Unable to create workspace' },
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
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    );
  }

  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Request body must be an object' },
      { status: 400 }
    );
  }

  const fields = Object.keys(body);
  if (fields.some((field) => field !== 'name')) {
    return NextResponse.json(
      { error: 'Request contains unsupported fields' },
      { status: 400 }
    );
  }

  const rawName = (body as { name?: unknown }).name;
  if (typeof rawName !== 'string') {
    return NextResponse.json(
      { error: "'name' must be a string" },
      { status: 400 }
    );
  }

  const name = rawName.trim();
  if (!name) {
    return NextResponse.json(
      { error: 'Workspace name required' },
      { status: 400 }
    );
  }
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    return NextResponse.json(
      {
        error: `Workspace name must be ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer`,
      },
      { status: 400 }
    );
  }

  // The authenticated RPC derives ownership from auth.uid() and enforces the
  // zero-membership/owner eligibility rule. Never accept or forward identity,
  // role, or account ownership fields from the client.
  const { data, error } = await supabase.rpc('create_workspace', {
    workspace_name: name,
  });
  if (error) return rpcErrorToResponse(error);

  if (typeof data !== 'string' || !UUID_PATTERN.test(data)) {
    console.error('[POST /api/account/create] Invalid RPC result');
    return NextResponse.json(
      { error: 'Unable to create workspace' },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, accountId: data });
}
