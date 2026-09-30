import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  getPropertyCommunicationSettings,
  PropertyCommunicationSettingsError,
  upsertPropertyCommunicationSettings,
} from '@/lib/properties/communication-settings';

function settingsErrorResponse(error: PropertyCommunicationSettingsError) {
  if (error.code === 'invalid_input') {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error.code === 'property_not_found') {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  return NextResponse.json(
    { error: 'Communication settings request failed.' },
    { status: 500 }
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const account = await getCurrentAccount();
    const { id } = await params;
    const settings = await getPropertyCommunicationSettings({
      accountId: account.accountId,
      pmsPropertyId: id,
      db: account.supabase,
    });
    return NextResponse.json(
      { settings },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return error instanceof PropertyCommunicationSettingsError
      ? settingsErrorResponse(error)
      : toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const account = await requireRole('admin');
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body.' },
        { status: 400 }
      );
    }

    const settings = await upsertPropertyCommunicationSettings({
      accountId: account.accountId,
      pmsPropertyId: id,
      values: body,
      db: account.supabase,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    return error instanceof PropertyCommunicationSettingsError
      ? settingsErrorResponse(error)
      : toErrorResponse(error);
  }
}
