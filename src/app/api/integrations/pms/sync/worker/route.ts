import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { runInitialPmsPropertySync } from '@/lib/integrations/pms/initial-sync';
import { authorizePmsWorkerRequest } from '@/lib/integrations/pms/worker-auth';

export const runtime = 'nodejs';

const MAX_PROPERTIES_PER_RUN = 10;

export async function POST(request: Request) {
  const authorization = authorizePmsWorkerRequest(request);
  if (authorization === 'not_configured') {
    return NextResponse.json(
      { error: 'PMS sync worker is not configured.' },
      { status: 503 }
    );
  }
  if (authorization === 'unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: properties, error } = await admin
    .from('pms_properties')
    .select('id')
    .or(
      `initial_sync_status.in.(pending,failed),and(initial_sync_status.eq.syncing,initial_sync_started_at.lt.${staleBefore})`
    )
    .order('updated_at', { ascending: true })
    .limit(MAX_PROPERTIES_PER_RUN);

  if (error) {
    return NextResponse.json(
      { error: 'PMS sync scan failed.' },
      { status: 500 }
    );
  }

  const results = [];
  for (const property of properties ?? []) {
    results.push(await runInitialPmsPropertySync(property.id));
  }

  return NextResponse.json({ processed: results.length, results });
}
