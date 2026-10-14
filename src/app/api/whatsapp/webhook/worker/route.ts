import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runWhatsAppWorker } from '@/lib/whatsapp/webhook-runtime';
import { cleanupDeletedConversationUploads } from '@/lib/inbox/delete-conversation';
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
    const deadline = Date.now() + 55_000;
    const result = await runWhatsAppWorker(db);
    try {
      await cleanupDeletedConversationUploads(
        db,
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        deadline
      );
    } catch {
      // Storage maintenance must not turn completed delivery work into a failure.
      console.warn('[whatsapp] deleted chat attachment cleanup deferred');
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Worker deferred' }, { status: 503 });
  }
}
