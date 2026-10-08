// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { resolveWhatsAppConnection } from '@/lib/whatsapp/connection-resolver';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { listMessageVariableDefinitions } from '@/lib/message-variables/catalog';
import { semanticBroadcastTemplateIssue } from '@/lib/broadcast-message-variables';
import { buildMetaTemplateMessagePayload } from './meta-template-payload';
import { TemplatePreparationError } from '@/lib/message-preparation/errors';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { validateBroadcastRecipientPhone } from './broadcast-recipient-phone';
import {
  claimBroadcastRecipient,
  broadcastSendFailure,
  recordBroadcastRecipientFailure,
  BROADCAST_DELIVERY_UNCONFIRMED,
} from './broadcast-delivery';
import {
  broadcastTemplateContent,
  persistBroadcastMessage,
} from './broadcast-message';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  whatsappConfigId?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  contactId?: string;
  phone: string;
  params: string[];
  messageParams?: SendTimeParams;
}

export interface BroadcastPlan {
  broadcastId: string;
  accountId?: string;
  connectionId?: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid or mismatched contact destination). */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Config (fail fast + provides the audit trail owner already resolved
  // by the caller). Meta send needs phone_number_id + decrypted token.
  const config = await resolveWhatsAppConnection(db, {
    accountId,
    connectionId: params.whatsappConfigId,
  }).catch(() => null);
  if (!config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  const accessToken = config.accessToken;

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage,
    config.id
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;
  const semantic = templateRow?.variable_configuration_status === 'configured';
  if (semantic) {
    const issue = semanticBroadcastTemplateIssue(
      templateRow,
      await listMessageVariableDefinitions({ db })
    );
    if (issue)
      throw new BroadcastError('template_context_required', issue, 400);
  }

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  // `to` is raw integrator input, so the leading `+` is required — a
  // national-format number would otherwise be delivered to whichever
  // country its leading digits spell (issue #586).
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const to = typeof r.to === 'string' ? r.to : '';
    const sanitized = parseInternationalPhone(to);
    if (!sanitized) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: to,
    });
    // Contact lookup may fuzzy-match a phone suffix. Do not attach frozen
    // recipient values to that contact unless its full destination agrees.
    const destination = await validateBroadcastRecipientPhone(
      db,
      accountId,
      id,
      sanitized
    );
    if (destination.error !== null) {
      rejected++;
      continue;
    }
    resolved.push({
      contactId: id,
      phone: destination.phone,
      params:
        !semantic && Array.isArray(r.params)
          ? r.params.filter((p): p is string => typeof p === 'string')
          : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed the same normalized phone twice).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid matching contact phone number. Use international format (leading + and country code, e.g. +14155550123).',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: deduped.map((r) => r.params),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] Could not create broadcast.', {
      code: createErr?.code,
    });
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;
  const { error: connectionPersistError } = await db
    .from('broadcasts')
    .update({
      whatsapp_config_id: config.id,
      ...(semantic
        ? { template_variables: { template_id: templateRow!.id } }
        : {}),
    })
    .eq('id', broadcastId)
    .eq('account_id', accountId);
  if (connectionPersistError) {
    throw new BroadcastError(
      'internal',
      'Failed to persist broadcast connection',
      500
    );
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return {
        recipientRowId: row.recipient_id,
        contactId: row.contact_id,
        phone: r.phone,
        params: r.params,
      };
    }
  );

  return {
    broadcastId,
    accountId,
    connectionId: config.id,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phoneNumberId,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  const { data: broadcast, error: broadcastError } = await db
    .from('broadcasts')
    .select('id')
    .eq('id', plan.broadcastId)
    .eq('account_id', plan.accountId)
    .eq('whatsapp_config_id', plan.connectionId)
    .maybeSingle();
  if (broadcastError || !broadcast)
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  const semantic =
    plan.templateRow?.variable_configuration_status === 'configured';
  let semanticIssue: string | null = null;
  if (semantic) {
    try {
      semanticIssue = semanticBroadcastTemplateIssue(
        plan.templateRow!,
        await listMessageVariableDefinitions({ db })
      );
    } catch {
      semanticIssue = 'The template variable catalog is unavailable.';
    }
  }
  for (const recipient of plan.planned) {
    const identity = {
      broadcastId: plan.broadcastId,
      recipientId: recipient.recipientRowId,
      contactId: recipient.contactId!,
    };
    const { data: saved, error: recipientError } = await db
      .from('broadcast_recipients')
      .select('id, whatsapp_message_id')
      .eq('id', recipient.recipientRowId)
      .eq('broadcast_id', plan.broadcastId)
      .eq('contact_id', recipient.contactId)
      .maybeSingle();
    if (recipientError || !saved) continue;
    // Acceptance is durable even if Inbox persistence or a browser status
    // update failed. A recovery pass must not deliver it a second time.
    if (saved.whatsapp_message_id) {
      await db
        .from('broadcast_recipients')
        .update({ status: 'sent' })
        .eq('id', recipient.recipientRowId)
        .eq('broadcast_id', plan.broadcastId)
        .in('status', ['pending', 'failed']);
      continue;
    }
    const destination = await validateBroadcastRecipientPhone(
      db,
      plan.accountId,
      recipient.contactId,
      recipient.phone
    );
    if (destination.error !== null) {
      await recordBroadcastRecipientFailure(db, identity, destination.error);
      continue;
    }
    // Never retry a contact-linked message to a guessed alternate number.
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    let templatePayload:
      ReturnType<typeof buildMetaTemplateMessagePayload> | undefined;
    if (semantic) {
      try {
        if (semanticIssue)
          throw new BroadcastError(
            'template_context_required',
            semanticIssue,
            400
          );
        if (!plan.accountId || !recipient.contactId)
          throw new TemplatePreparationError('invalid_input');
        const { prepareTemplateMessage } =
          await import('@/lib/message-preparation/prepare-template-message');
        const prepared = await prepareTemplateMessage(
          {
            accountId: plan.accountId,
            templateId: plan.templateRow!.id,
            context: { contactId: recipient.contactId },
          },
          { db }
        );
        if (prepared.template.connectionId !== plan.connectionId)
          throw new TemplatePreparationError('template_connection_invalid');
        templatePayload = buildMetaTemplateMessagePayload(prepared);
      } catch (error) {
        await recordBroadcastRecipientFailure(
          db,
          identity,
          error instanceof BroadcastError
            ? error.message
            : 'Required template or contact information is unavailable.'
        );
        continue;
      }
    }
    try {
      if (!(await claimBroadcastRecipient(db, identity))) continue;
    } catch {
      console.error('[broadcast] Recipient claim unavailable.', {
        recipientId: recipient.recipientRowId,
      });
      continue;
    }
    try {
      const result = await sendTemplateMessage({
        phoneNumberId: plan.phoneNumberId,
        accessToken: plan.accessToken,
        to: destination.phone,
        templateName: plan.templateName,
        language: plan.templateLanguage,
        templatePayload,
        template: semantic ? undefined : (plan.templateRow ?? undefined),
        params: semantic ? undefined : recipient.params,
        messageParams: semantic ? undefined : recipient.messageParams,
      });
      sentMessageId = result.messageId;
      lastError = null;
    } catch (error) {
      lastError = broadcastSendFailure(error);
    }

    if (sentMessageId) {
      // Record acceptance before any conversation/message persistence.
      try {
        const { error: acceptanceError } = await db
          .from('broadcast_recipients')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: sentMessageId,
            error_message: null,
          })
          .eq('id', recipient.recipientRowId)
          .eq('broadcast_id', plan.broadcastId)
          .eq('error_message', BROADCAST_DELIVERY_UNCONFIRMED)
          .is('whatsapp_message_id', null);
        if (acceptanceError) throw new Error('Acceptance could not be saved.');
        await persistBroadcastMessage(db, {
          accountId: plan.accountId!,
          connectionId: plan.connectionId!,
          contactId: recipient.contactId!,
          messageId: sentMessageId,
          templateName: plan.templateName,
          contentText: broadcastTemplateContent(
            plan.templateRow,
            recipient.params,
            recipient.messageParams,
            templatePayload
          ),
        });
      } catch {
        // Meta accepted. Keep the wamid and sent state; never enqueue a resend
        // because local Inbox persistence failed.
        console.error(
          '[broadcast] Accepted message could not be saved to Inbox.',
          {
            broadcastId: plan.broadcastId,
            recipientId: recipient.recipientRowId,
            messageId: sentMessageId,
          }
        );
      }
    } else {
      await recordBroadcastRecipientFailure(
        db,
        identity,
        lastError || BROADCAST_DELIVERY_UNCONFIRMED,
        true
      );
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}
