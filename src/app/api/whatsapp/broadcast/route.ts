import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { resolveWhatsAppConnection } from '@/lib/whatsapp/connection-resolver';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { listMessageVariableDefinitions } from '@/lib/message-variables/catalog';
import { semanticBroadcastTemplateIssue } from '@/lib/broadcast-message-variables';
import { buildMetaTemplateMessagePayload } from '@/lib/whatsapp/meta-template-payload';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { validateBroadcastRecipientPhone } from '@/lib/whatsapp/broadcast-recipient-phone';
import {
  broadcastTemplateContent,
  persistBroadcastMessage,
} from '@/lib/whatsapp/broadcast-message';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import {
  claimBroadcastRecipient,
  broadcastSendFailure,
  recordBroadcastRecipientFailure,
  BROADCAST_DELIVERY_UNCONFIRMED,
} from '@/lib/whatsapp/broadcast-delivery';
import { finalizeBroadcastStatus } from '@/lib/whatsapp/broadcast-core';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

interface BroadcastResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string;
  contact_id?: string;
  recipient_id?: string;
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[];
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). When set, takes
   * precedence over `params` for the body too — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams;
}

export async function POST(request: Request) {
  try {
    // Requires the 'agent' role — `canSendMessages` in lib/auth/roles is
    // explicit that running broadcasts is a write operation and that
    // viewers are read-only.
    const { supabase, accountId, userId } = await requireRole('agent');

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_id,
      template_language,
      template_params,
      whatsapp_config_id,
      broadcast_id,
    } = body;

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[];
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients;
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : [];
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }));
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      );
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      );
    }

    const config = await resolveWhatsAppConnection(supabase, {
      accountId,
      connectionId:
        typeof whatsapp_config_id === 'string' ? whatsapp_config_id : null,
    }).catch(() => null);

    if (!config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      );
    }

    const accessToken = config.accessToken;
    if (broadcast_id !== undefined) {
      const { data: broadcast, error } = await supabase
        .from('broadcasts')
        .select('id')
        .eq('id', broadcast_id)
        .eq('account_id', accountId)
        .eq('whatsapp_config_id', config.id)
        .maybeSingle();
      if (error || !broadcast)
        return NextResponse.json(
          { error: 'Broadcast not found.' },
          { status: 404 }
        );
    }

    // Load the template row once so sendTemplateMessage can build
    // header + button components on each iteration. Loading inside
    // the loop would N+1 against Supabase for every recipient.
    // Guard against a malformed local row crashing every send in
    // the loop with the same opaque TypeError — fail loudly once.
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language,
      config.id
    );
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 }
      );
    }
    const templateRow = resolvedTemplate.row;
    if (template_id !== undefined && template_id !== templateRow?.id)
      return NextResponse.json(
        { error: 'The selected broadcast template is unavailable.' },
        { status: 400 }
      );
    if (
      template_id !== undefined &&
      templateRow?.variable_configuration_status !== 'configured'
    )
      return NextResponse.json(
        { error: 'This template is not ready to send.' },
        { status: 400 }
      );
    const semantic =
      templateRow?.variable_configuration_status === 'configured';
    if (semantic) {
      const issue = semanticBroadcastTemplateIssue(
        templateRow,
        await listMessageVariableDefinitions({ db: supabase })
      );
      if (issue) return NextResponse.json({ error: issue }, { status: 400 });
    }

    const results: BroadcastResult[] = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      if (broadcast_id !== undefined) {
        const { data: saved, error } = await supabase
          .from('broadcast_recipients')
          .select('id, whatsapp_message_id')
          .eq('id', recipient.recipient_id)
          .eq('broadcast_id', broadcast_id)
          .eq('contact_id', recipient.contact_id)
          .maybeSingle();
        if (error || !saved) {
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: 'Broadcast recipient is unavailable.',
          });
          failedCount++;
          continue;
        }
        if (saved.whatsapp_message_id) {
          await supabase
            .from('broadcast_recipients')
            .update({ status: 'sent' })
            .eq('id', recipient.recipient_id)
            .eq('broadcast_id', broadcast_id)
            .eq('contact_id', recipient.contact_id)
            .in('status', ['pending', 'failed']);
          results.push({
            phone: recipient.phone,
            status: 'sent',
            whatsapp_message_id: saved.whatsapp_message_id,
          });
          sentCount++;
          continue;
        }
      }
      const contactLinked = semantic || recipient.contact_id !== undefined;
      const destination = contactLinked
        ? await validateBroadcastRecipientPhone(
            supabase,
            accountId,
            recipient.contact_id,
            recipient.phone
          )
        : null;
      if (destination?.error) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: destination.error,
        });
        failedCount++;
        continue;
      }
      const sanitized =
        destination?.phone ?? sanitizePhoneForMeta(recipient.phone);

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        });
        failedCount++;
        continue;
      }
      // Phone-only legacy API sends still need a normal, validated contact
      // for Inbox persistence. Never accept a fuzzy match to another phone.
      let contactId = recipient.contact_id;
      if (!contactLinked) {
        try {
          const contact = await findOrCreateContact(
            supabase,
            accountId,
            userId,
            { phone: `+${sanitized}` }
          );
          const checked = await validateBroadcastRecipientPhone(
            supabase,
            accountId,
            contact.id,
            sanitized
          );
          if (checked.error) throw new Error(checked.error);
          contactId = contact.id;
        } catch {
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: 'Recipient contact is unavailable.',
          });
          failedCount++;
          continue;
        }
      }

      // Every persisted send now belongs to a validated contact. Never send
      // its content to a guessed alternate destination.
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      let templatePayload:
        ReturnType<typeof buildMetaTemplateMessagePayload> | undefined;
      if (semantic) {
        try {
          const { prepareTemplateMessage } =
            await import('@/lib/message-preparation/prepare-template-message');
          const prepared = await prepareTemplateMessage(
            {
              accountId,
              templateId: templateRow!.id,
              context: { contactId: recipient.contact_id },
            },
            { db: supabase }
          );
          if (prepared.template.connectionId !== config.id)
            throw new Error('Template connection mismatch');
          templatePayload = buildMetaTemplateMessagePayload(prepared);
        } catch {
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: 'Required template or contact information is unavailable.',
          });
          failedCount++;
          continue;
        }
      }
      const identity =
        broadcast_id !== undefined
          ? {
              broadcastId: broadcast_id,
              recipientId: recipient.recipient_id!,
              contactId: contactId!,
            }
          : null;
      if (identity) {
        try {
          if (!(await claimBroadcastRecipient(supabase, identity))) {
            results.push({
              phone: recipient.phone,
              status: 'failed',
              error: BROADCAST_DELIVERY_UNCONFIRMED,
            });
            failedCount++;
            continue;
          }
        } catch {
          results.push({
            phone: recipient.phone,
            status: 'failed',
            error: 'Recipient could not be claimed. No message was sent.',
          });
          failedCount++;
          continue;
        }
      }
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phoneNumberId,
          accessToken,
          to: sanitized,
          templateName: template_name,
          language: resolvedTemplate.language,
          templatePayload,
          template: semantic ? undefined : (templateRow ?? undefined),
          messageParams: semantic ? undefined : recipient.messageParams,
          params: semantic ? undefined : (recipient.params ?? []),
        });
        sentMessageId = result.messageId;
      } catch (error) {
        lastError = broadcastSendFailure(error);
        if (identity)
          await recordBroadcastRecipientFailure(
            supabase,
            identity,
            lastError,
            true
          );
      }

      if (sentMessageId) {
        let persistenceError: string | undefined;
        try {
          if (broadcast_id !== undefined) {
            const { error } = await supabase
              .from('broadcast_recipients')
              .update({
                status: 'sent',
                whatsapp_message_id: sentMessageId,
                sent_at: new Date().toISOString(),
                error_message: null,
              })
              .eq('id', recipient.recipient_id)
              .eq('broadcast_id', broadcast_id)
              .eq('contact_id', contactId)
              .eq('error_message', BROADCAST_DELIVERY_UNCONFIRMED)
              .is('whatsapp_message_id', null);
            if (error) throw new Error('Acceptance could not be saved.');
          }
          await persistBroadcastMessage(supabase, {
            accountId,
            connectionId: config.id,
            contactId: contactId!,
            messageId: sentMessageId,
            templateName: template_name,
            contentText: broadcastTemplateContent(
              templateRow,
              recipient.params ?? [],
              recipient.messageParams,
              templatePayload
            ),
          });
        } catch {
          persistenceError = 'Sent to WhatsApp, but could not save to Inbox.';
          console.error(
            '[broadcast] Accepted message could not be saved to Inbox.',
            {
              broadcastId: broadcast_id,
              recipientId: recipient.recipient_id,
              messageId: sentMessageId,
            }
          );
        }
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
          ...(persistenceError ? { error: persistenceError } : {}),
        });
        sentCount++;
      } else {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        });
        failedCount++;
      }
    }

    if (broadcast_id !== undefined) {
      for (const [index, result] of results.entries()) {
        if (result.status !== 'failed') continue;
        const recipient = recipients[index];
        await recordBroadcastRecipientFailure(
          supabase,
          {
            broadcastId: broadcast_id,
            recipientId: recipient.recipient_id!,
            contactId: recipient.contact_id!,
          },
          result.error ?? 'Required recipient information is unavailable.'
        );
      }
      await finalizeBroadcastStatus(supabase, broadcast_id);
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    });
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp broadcast POST.', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    return toErrorResponse(error);
  }
}
