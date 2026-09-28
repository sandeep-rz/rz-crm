import { NextResponse } from 'next/server';

import { authorizePmsWorkerRequest } from '@/lib/integrations/pms/worker-auth';
import { runPmsWebhookEventWorker } from '@/lib/integrations/pms/webhooks/event-processor';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const authorization = authorizePmsWorkerRequest(request);
  if (authorization === 'not_configured') {
    return NextResponse.json(
      { error: 'PMS webhook worker is not configured.' },
      { status: 503 }
    );
  }
  if (authorization === 'unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return NextResponse.json(await runPmsWebhookEventWorker());
  } catch {
    return NextResponse.json(
      { error: 'PMS webhook worker failed.' },
      { status: 500 }
    );
  }
}
