import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { findOrCreateConversationRow } from './resolve-conversation';
import { templateContentText, templateBodyParams } from './template-body';
import type { SendTimeParams } from './template-send-builder';
import type { MessageTemplate } from '@/types';
import type { SendTemplateMessageArgs } from './meta-api';

export function broadcastTemplateContent(
  template: MessageTemplate | null,
  params: string[],
  messageParams?: SendTimeParams,
  payload?: SendTemplateMessageArgs['templatePayload']
): string | null {
  const body = payload?.components?.find(
    (component) => component.type === 'body'
  );
  return templateContentText(
    template,
    payload
      ? (body?.parameters ?? []).map((parameter) =>
          parameter.type === 'text' ? parameter.text : ''
        )
      : templateBodyParams(params, messageParams)
  );
}

/** Persist an already accepted send. This function must never call Meta. */
export async function persistBroadcastMessage(
  db: SupabaseClient,
  input: {
    accountId: string;
    connectionId: string;
    contactId: string;
    messageId: string;
    templateName: string;
    contentText: string | null;
  }
): Promise<void> {
  const conversationId = await findOrCreateConversationRow(
    db,
    input.accountId,
    input.contactId,
    await resolveAuditUserId(db, input.accountId),
    input.connectionId
  );
  // Reuse the existing (conversation_id, message_id) uniqueness protection.
  const { error } = await db.from('messages').upsert(
    {
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: 'template',
      content_text: input.contentText,
      template_name: input.templateName,
      message_id: input.messageId,
      status: 'sent',
    },
    { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
  );
  if (error) throw new Error('Could not save the accepted broadcast message.');
  const { error: previewError } = await db
    .from('conversations')
    .update({
      last_message_text: input.contentText || '[template]',
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .eq('whatsapp_config_id', input.connectionId);
  if (previewError)
    throw new Error('Could not update the conversation preview.');
}
