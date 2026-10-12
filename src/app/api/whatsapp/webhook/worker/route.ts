import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runWhatsAppWorker } from '@/lib/whatsapp/webhook-runtime';
export const maxDuration = 60;
export async function POST(request: Request) {
  const expected = process.env.WHATSAPP_WORKER_TOKEN;
  const provided = request.headers.get('x-whatsapp-worker-token');
  if (!expected || expected.length < 32)
    return NextResponse.json({ error: 'Worker unavailable' }, { status: 503 });
  if (
    !provided ||
    Buffer.byteLength(provided) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    return NextResponse.json(await runWhatsAppWorker(db));
  } catch {
    return NextResponse.json({ error: 'Worker deferred' }, { status: 503 });
  }
}
