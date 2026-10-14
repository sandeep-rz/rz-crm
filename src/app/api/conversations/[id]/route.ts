import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { cleanupConversationMedia } from '@/lib/inbox/delete-conversation';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(
      `admin:conversationDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id
      )
    ) {
      return NextResponse.json(
        { error: 'Invalid conversation' },
        { status: 400 }
      );
    }
    const body = await request.json().catch(() => null);
    // A stale tab must not apply the request in a newly selected workspace.
    if (body?.confirm !== true || body?.accountId !== ctx.accountId) {
      return NextResponse.json(
        { error: 'Confirm deletion in the current workspace' },
        { status: 400 }
      );
    }
    const { data, error } = await ctx.supabase.rpc(
      'delete_conversation_permanently',
      {
        p_account: ctx.accountId,
        p_conversation: id,
      }
    );
    if (error) {
      if (error.message.includes('conversation_busy'))
        return NextResponse.json(
          {
            error:
              'Chat is processing a reply. Wait a few minutes, then try again.',
          },
          { status: 409 }
        );
      if (error.code === '42501')
        return NextResponse.json(
          { error: 'Insufficient role' },
          { status: 403 }
        );
      console.error('[conversation delete]', error.code);
      return NextResponse.json(
        { error: 'Could not delete conversation' },
        { status: 500 }
      );
    }
    if (!data)
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    // DB deletion has committed. Storage failures must never report the chat as intact.
    let cleanupPending = true;
    try {
      const admin = supabaseAdmin();
      // Bound each request; a large thread can finish cleanup through the same
      // idempotent endpoint without another worker or scheduler.
      const urls: string[] = data.media_urls ?? [];
      const remaining = urls.slice(25);
      const failed = await cleanupConversationMedia(
        admin,
        ctx.accountId,
        urls.slice(0, 25),
        process.env.NEXT_PUBLIC_SUPABASE_URL!
      );
      const pending = [...remaining, ...failed];
      const { error: saveError } = await admin
        .from('conversation_deletions')
        .update({ media_urls: pending })
        .eq('conversation_id', id)
        .eq('account_id', ctx.accountId);
      cleanupPending = pending.length > 0 || !!saveError;
    } catch {
      /* The retained URLs let this same DELETE safely retry cleanup. */
    }
    return NextResponse.json({ success: true, cleanupPending });
  } catch (error) {
    return toErrorResponse(error);
  }
}
