import { NextResponse } from 'next/server';

import { runPmsAutomationJobWorker } from '@/lib/automations/pms-worker';
import { authorizePmsWorkerRequest } from '@/lib/integrations/pms/worker-auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const authorization = authorizePmsWorkerRequest(request);
  if (authorization === 'not_configured') {
    return NextResponse.json(
      { error: 'PMS automation worker is not configured.' },
      { status: 503 },
    );
  }
  if (authorization === 'unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json(await runPmsAutomationJobWorker());
  } catch {
    return NextResponse.json({ error: 'PMS automation worker failed.' }, { status: 500 });
  }
}
