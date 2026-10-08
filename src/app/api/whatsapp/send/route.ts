import { TemplatePreparationError } from '@/lib/message-preparation/errors';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { resolveWhatsAppConnection } from '@/lib/whatsapp/connection-resolver';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    // Requires the 'agent' role, matching both `canSendMessages` and the
    // `messages_modify` RLS policy (migration 017).
    //
    // Resolving `account_id` off the profile — which any 'viewer' has —
    // was previously the only gate. RLS did block the message INSERT, but
    // the send core calls Meta BEFORE it persists, so a viewer's request
    // still delivered a real WhatsApp message to the customer and merely
    // failed to record it (surfacing as "sent to Meta but failed to save
    // to DB"). RLS can't un-send that, so the role check belongs here.
    const { supabase, accountId, userId } = await requireRole('agent');

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_id,
      reservation_id,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
      whatsapp_config_id,
    } = body;

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      );
    }

    for (const id of [template_id, reservation_id]) {
      if (
        id !== undefined &&
        (typeof id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            id
          ))
      )
        return NextResponse.json(
          { error: 'Invalid template or reservation selection.' },
          { status: 400 }
        );
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        templateId: template_id,
        interactivePayload: interactive_payload,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        );
      }
      throw err;
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null;

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single();

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        );
      }
      conversationId = data.id;
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle();

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        );
      }

      const resolved = await findOrCreateConversation(
        supabase,
        accountId,
        userId,
        contact_id,
        typeof whatsapp_config_id === 'string' ? whatsapp_config_id : null
      );
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        );
      }
      conversationId = resolved;
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(
        supabase,
        accountId,
        {
          conversationId,
          whatsappConfigId:
            typeof whatsapp_config_id === 'string' ? whatsapp_config_id : null,
          messageType: message_type,
          contentText: content_text,
          mediaUrl: media_url,
          filename,
          templateName: template_name,
          templateLanguage: template_language,
          templateParams: template_params,
          templateMessageParams: template_message_params,
          interactivePayload: interactive_payload,
          replyToMessageId: reply_to_message_id,
        },
        message_type === 'template'
          ? { templateId: template_id, reservationId: reservation_id }
          : undefined
      );

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        content_text: result.contentText,
      });
    } catch (err) {
      if (err instanceof TemplatePreparationError) {
        const missingReservation = err.diagnostics.runtimeFailures?.some(
          (failure) => failure.code === 'reservation_context_required'
        );
        const unavailable = [
          'variable_missing',
          'variable_unsupported',
          'runtime_provider_failure',
          'runtime_resolution_failure',
        ].includes(err.code);
        return NextResponse.json(
          {
            code: err.code,
            error: missingReservation
              ? 'Select a reservation before sending this template.'
              : unavailable
                ? 'Some required contact or reservation information is unavailable.'
                : 'This template is not ready to send.',
          },
          { status: 400 }
        );
      }
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          {
            code: err.code,
            ...(err.acceptedMessageId
              ? {
                  delivery_state: 'accepted',
                  whatsapp_message_id: err.acceptedMessageId,
                }
              : {}),
            error:
              message_type === 'template' && err.code === 'meta_error'
                ? 'WhatsApp could not send this template.'
                : message_type === 'template' && err.code === 'db_error'
                  ? 'This template could not be prepared. No message was sent.'
                  : err.message,
          },
          { status: err.status }
        );
      }
      throw err;
    }
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp send POST:', error);
    return toErrorResponse(error);
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
  connectionId?: string | null
): Promise<string | null> {
  const connection = await resolveWhatsAppConnection(supabase, {
    accountId,
    connectionId,
  });
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', connection.id)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      whatsapp_config_id: connection.id,
    })
    .select('id')
    .single();

  if (error) {
    console.error(
      'Error creating conversation for contact send:',
      error.message
    );
    return null;
  }

  return created.id;
}
