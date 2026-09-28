import { NextResponse } from 'next/server';

import { runPmsReservationReconciliationWorker } from '@/lib/integrations/pms/reconciliation';
import { authorizePmsWorkerRequest } from '@/lib/integrations/pms/worker-auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const authorization = authorizePmsWorkerRequest(request);
  if (authorization === 'not_configured') {
    return NextResponse.json(
      { error: 'PMS reconciliation worker is not configured.' },
      { status: 503 }
    );
  }
  if (authorization === 'unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return NextResponse.json(await runPmsReservationReconciliationWorker());
  } catch {
    return NextResponse.json(
      { error: 'PMS reconciliation worker failed.' },
      { status: 500 }
    );
  }
}
