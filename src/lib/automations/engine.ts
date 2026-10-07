import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  PmsTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types';
import { supabaseAdmin } from './admin-client';
import {
  addContactTagIfAbsent,
  removeContactTag,
} from '@/lib/contacts/tag-write';
import {
  MAX_TAG_CHAIN_DEPTH,
  getTagChainDepth,
} from '@/lib/contacts/tag-chain';
import {
  engineSendText,
  engineSendTemplate,
  engineSendInteractive,
} from './meta-send';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { resolveWhatsAppConnection } from '@/lib/whatsapp/connection-resolver';
import { resolveConversationForContact } from '@/lib/whatsapp/resolve-conversation';
import type { ReservationAutomationContext } from './pms-context';
import { matchesReservationTriggerConfig } from './pms-scheduler';
import { buildAndResolveMessageVariables } from '@/lib/message-variables';
import { groupResolvedTemplateParameters } from './template-variable-mapping';
import { AutomationTemplateSendError } from './template-send-error';
import { WhatsAppConnectionError } from '@/lib/whatsapp/connection-resolver';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { TemplatePreparationError } from '@/lib/message-preparation/errors';

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string;
  /** Conversation the event belongs to, if any. */
  conversation_id?: string;
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>;
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string;
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string;
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string;
  /** Canonical, credential-free PMS projection for reservation triggers. */
  reservation?: ReservationAutomationContext;
}

export interface AutomationExecutionResult {
  logId: string | null;
  status: 'success' | 'partial' | 'failed' | 'processing' | 'suppressed';
  errorMessage: string | null;
  retryable?: boolean;
  disposition:
    | 'executed'
    | 'already_completed'
    | 'already_running'
    | 'ineligible'
    | 'reservation_changed';
}

export interface AutomationExecutionIdentity {
  triggerJobId: string;
  attemptCount: number;
  expectedReservationUpdatedAt: string;
}

type PmsExecutionGateDisposition =
  | 'started'
  | 'already_completed'
  | 'already_running'
  | 'ineligible'
  | 'reservation_changed';

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string;
  triggerType: AutomationTriggerType;
  contactId?: string | null;
  context?: AutomationContext;
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(
  input: DispatchInput
): Promise<void> {
  try {
    const db = supabaseAdmin();

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle();
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr);
        return;
      }
      if (!owned) {
        console.warn(
          '[automations] contact not in account, refusing dispatch',
          input.contactId
        );
        return;
      }
    }

    // Same argument for `context.conversation_id` (GHSA-m4fx-g6pr-hrw8).
    // It rides in on the same caller-supplied body, and every send step
    // writes a `messages` row and a `conversations` preview update keyed
    // on it through the service-role client — so an unvalidated id let a
    // caller inject a message into another tenant's conversation. Refuse
    // the same way: silently, with no existence oracle.
    if (input.context?.conversation_id) {
      const { data: conv, error: convErr } = await db
        .from('conversations')
        .select('id')
        .eq('id', input.context.conversation_id)
        .eq('account_id', input.accountId)
        .maybeSingle();
      if (convErr) {
        console.error(
          '[automations] conversation ownership check failed:',
          convErr
        );
        return;
      }
      if (!conv) {
        console.warn(
          '[automations] conversation not in account, refusing dispatch',
          input.context.conversation_id
        );
        return;
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true);

    if (error) {
      console.error('[automations] fetch failed:', error);
      return;
    }
    if (!automations || automations.length === 0) return;

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue;
      try {
        await executeAutomation(automation, input);
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err);
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err);
  }
}

/**
 * Dispatch exactly one already-selected automation through the same executor.
 * PMS trigger jobs use this to avoid re-running every matching automation for
 * each per-automation durable occurrence.
 */
export async function runAutomationForTrigger(
  automationId: string,
  input: DispatchInput,
  executionIdentity?: AutomationExecutionIdentity
): Promise<AutomationExecutionResult | null> {
  const db = supabaseAdmin();
  if (input.contactId) {
    const { data: contact, error } = await db
      .from('contacts')
      .select('id')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle();
    if (error) throw new Error('automation contact ownership check failed');
    if (!contact) return null;
  }
  const { data, error } = await db
    .from('automations')
    .select('*')
    .eq('id', automationId)
    .eq('account_id', input.accountId)
    .eq('trigger_type', input.triggerType)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw new Error('automation lookup failed');
  if (!data) return null;
  const automation = data as Automation;
  if (!triggerMatches(automation, input.context)) return null;
  return executeAutomation(automation, input, executionIdentity);
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string;
  automation_id: string;
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string;
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string;
  contact_id: string | null;
  log_id: string | null;
  parent_step_id: string | null;
  branch: 'yes' | 'no' | null;
  next_step_position: number;
  context: AutomationContext;
}): Promise<void> {
  const db = supabaseAdmin();
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .eq('account_id', pending.account_id)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error(
      '[automations] resume: automation lookup failed',
      pending.automation_id,
      error
    );
    throw new Error('automation lookup failed while resuming continuation');
  }
  if (!automation) {
    // Deactivation is a hard boundary for delayed continuations too. Treat a
    // missing/inactive/cross-account definition as terminally suppressed.
    await markPending(pending.id, 'done');
    return;
  }

  if (!pending.log_id) {
    throw new Error('wait continuation is missing its automation log identity');
  }
  const { data: log, error: logError } = await db
    .from('automation_logs')
    .select('completed_wait_continuation_ids')
    .eq('id', pending.log_id)
    .eq('account_id', pending.account_id)
    .eq('automation_id', pending.automation_id)
    .maybeSingle();
  if (logError) throw new Error('wait continuation completion lookup failed');
  if (!log) throw new Error('wait continuation automation log is invalid');
  const completedIds =
    (log.completed_wait_continuation_ids as string[] | null) ?? [];
  if (completedIds.includes(pending.id)) {
    await markPending(pending.id, 'done');
    return;
  }

  await executeStepsFrom({
    automation: automation as Automation,
    contactId: pending.contact_id,
    context: pending.context ?? {},
    parentStepId: pending.parent_step_id,
    branch: pending.branch,
    startPosition: pending.next_step_position,
    logId: pending.log_id,
    triggerEvent: 'resumed_wait',
    triggerJobExecution: false,
    continuationId: pending.id,
  });
  await markPending(pending.id, 'done');
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(
  automation: Automation,
  input: DispatchInput,
  executionIdentity?: AutomationExecutionIdentity
): Promise<AutomationExecutionResult | null> {
  const db = supabaseAdmin();

  let log: { id: string };
  if (executionIdentity) {
    const { data: gateData, error: gateError } = await db.rpc(
      'begin_pms_automation_execution',
      {
        p_job_id: executionIdentity.triggerJobId,
        p_attempt_count: executionIdentity.attemptCount,
        p_contact_id: input.contactId ?? null,
        p_expected_reservation_updated_at:
          executionIdentity.expectedReservationUpdatedAt,
      }
    );
    const gate = (Array.isArray(gateData) ? gateData[0] : gateData) as {
      automation_log_id: string;
      disposition: PmsExecutionGateDisposition;
    } | null;
    if (gateError || !gate) {
      throw new Error(
        `cannot acquire PMS automation execution: ${gateError?.message ?? 'unknown error'}`
      );
    }
    if (
      gate.disposition === 'ineligible' ||
      gate.disposition === 'reservation_changed'
    ) {
      return {
        logId: null,
        status: 'suppressed',
        errorMessage: null,
        disposition: gate.disposition,
      };
    }
    if (!gate.automation_log_id) {
      throw new Error(
        'cannot acquire PMS automation execution: missing log identity'
      );
    }
    log = { id: gate.automation_log_id };
    if (
      gate.disposition === 'already_completed' ||
      gate.disposition === 'already_running'
    ) {
      const { data: existingLog, error: existingLogError } = await db
        .from('automation_logs')
        .select('status, error_message')
        .eq('id', log.id)
        .eq('trigger_job_id', executionIdentity.triggerJobId)
        .single();
      if (existingLogError || !existingLog) {
        throw new Error('cannot read existing PMS automation execution');
      }
      return {
        logId: log.id,
        status:
          gate.disposition === 'already_running'
            ? 'processing'
            : (existingLog.status as AutomationExecutionResult['status']),
        errorMessage: existingLog.error_message as string | null,
        disposition: gate.disposition,
      };
    }
  } else {
    const { data: insertedLog, error: logErr } = await db
      .from('automation_logs')
      .insert({
        automation_id: automation.id,
        // Tenancy: matches automation.account_id (NOT NULL post-017).
        account_id: automation.account_id,
        // Audit: keeps the historical "author of this automation"
        // pointer so logs still attribute to the right user even
        // after teammates join the account.
        user_id: automation.user_id,
        contact_id: input.contactId ?? null,
        trigger_event: input.triggerType,
        steps_executed: [],
        // Existing non-PMS behavior remains pessimistic: success is only
        // written after the complete step scope reaches its terminal path.
        status: 'failed',
      })
      .select()
      .single();

    if (logErr || !insertedLog) {
      throw new Error(
        `cannot create automation log: ${logErr?.message ?? 'unknown error'}`
      );
    }
    log = { id: insertedLog.id as string };
  }

  const failure: { retryable?: boolean } = {};
  await executeStepsFrom({
    failure,
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
    triggerJobExecution: Boolean(executionIdentity),
  });

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc(
    'increment_automation_execution_count',
    {
      p_automation_id: automation.id,
    }
  );
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr);
  }

  const { data: finalLog, error: finalLogError } = await db
    .from('automation_logs')
    .select('status, error_message')
    .eq('id', log.id)
    .single();
  if (finalLogError || !finalLog) {
    throw new Error('cannot read final automation execution status');
  }
  return {
    logId: log.id as string,
    status: finalLog.status as AutomationExecutionResult['status'],
    errorMessage: finalLog.error_message as string | null,
    disposition: 'executed',
    ...(failure.retryable !== undefined
      ? { retryable: failure.retryable }
      : {}),
  };
}

interface ExecuteArgs {
  failure?: { retryable?: boolean };
  automation: Automation;
  contactId: string | null;
  context: AutomationContext;
  parentStepId: string | null;
  branch: 'yes' | 'no' | null;
  startPosition: number;
  logId: string | null;
  triggerEvent: string;
  triggerJobExecution: boolean;
  /** Stable automation_pending_executions.id for a resumed Wait segment. */
  continuationId?: string | null;
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const db = supabaseAdmin();

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true });

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery
          .eq('parent_step_id', args.parentStepId)
          .eq('branch', args.branch ?? 'yes');

  const { data: steps, error: stepsErr } = await scoped;

  if (stepsErr) {
    await finalizeLog(
      args.logId,
      'failed',
      stepsErr.message,
      args.triggerJobExecution
    );
    throw new Error('wait continuation step lookup failed');
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null, args.triggerJobExecution);
    }
    await recordWaitContinuationCompleted(args);
    return;
  }

  const results: AutomationLogStepResult[] = [];
  let status: 'success' | 'partial' | 'failed' = 'success';
  let errorMessage: string | null = null;

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig;
      const ms = waitMs(cfg);
      await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      });
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      });
      status = 'partial';
      await appendResults(
        args.logId,
        results,
        status,
        errorMessage,
        args.triggerJobExecution
      );
      await recordWaitContinuationCompleted(args);
      return;
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig;
        const taken = await evaluateCondition(cfg, args);
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        });
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
          continuationId: null,
        });
        if (args.failure?.retryable !== undefined) {
          status = 'failed';
          break;
        }
        continue;
      }

      const detail = await executeAutomationStep(step, args);
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      });
    } catch (err) {
      const msg =
        err instanceof TemplatePreparationError
          ? [
              err.code,
              err.diagnostics.variableKey
                ? `variable_key=${err.diagnostics.variableKey}`
                : null,
              ...(err.diagnostics.runtimeFailures ?? []).map(
                (f) =>
                  `${f.source}:${f.code}${f.httpStatus ? ` HTTP=${f.httpStatus}` : ''}`
              ),
            ]
              .filter(Boolean)
              .join('; ')
          : err instanceof Error
            ? err.message
            : String(err);
      if (
        (err instanceof TemplatePreparationError ||
          err instanceof AutomationTemplateSendError) &&
        args.failure
      )
        args.failure.retryable = err.retryable;
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      });
      status = 'failed';
      errorMessage = msg;
      break;
    }
  }

  if (args.parentStepId === null) {
    await appendResults(
      args.logId,
      results,
      status,
      errorMessage,
      args.triggerJobExecution
    );
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(
      args.logId,
      results,
      null,
      errorMessage,
      args.triggerJobExecution
    );
  }
  await recordWaitContinuationCompleted(args);
}

/** Trusted engine step boundary, also used for read-only DEV verification. */
export async function executeAutomationStep(
  step: AutomationStep,
  args: ExecuteArgs
): Promise<string> {
  const db = supabaseAdmin();

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig;
      if (!args.contactId) throw new Error('send_message needs a contact');
      const text = interpolate(cfg.text, args);
      if (!text.trim()) throw new Error('send_message has empty text');
      const conversationId = await resolveConversationId(args);
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      });
      return `sent via Meta (${whatsapp_message_id})`;
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as
        SendButtonsStepConfig | SendListStepConfig;
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`);
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload);
      if (!check.ok) throw new Error(check.error);
      const conversationId = await resolveConversationId(args);
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      });
      return `interactive sent via Meta (${whatsapp_message_id})`;
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig;
      if (!args.contactId) {
        if (cfg.template_id !== undefined)
          throw new TemplatePreparationError('invalid_input');
        throw new Error('send_template needs a contact');
      }
      // Identity, never a cached name or action-level mapping, selects this path.
      if (cfg.template_id !== undefined) {
        const reservationId = args.context.reservation?.reservation_id;
        // Load server-only preparation only for semantic actions.
        const { prepareTemplateMessage } =
          await import('@/lib/message-preparation/prepare-template-message');
        const { buildMetaTemplateMessagePayload } =
          await import('@/lib/whatsapp/meta-template-payload');
        const prepared = await prepareTemplateMessage({
          accountId: args.automation.account_id,
          templateId: cfg.template_id,
          context: { contactId: args.contactId, reservationId },
        });
        const templatePayload = buildMetaTemplateMessagePayload(prepared);
        try {
          const conversationId = await resolveConversationId(
            args,
            prepared.template.connectionId
          );
          const { whatsapp_message_id } = await engineSendTemplate({
            accountId: args.automation.account_id,
            userId: args.automation.user_id,
            conversationId,
            contactId: args.contactId,
            templateName: prepared.template.name,
            language: prepared.template.language,
            connectionId: prepared.template.connectionId,
            preparedTemplate: prepared,
            templatePayload,
          });
          return `template sent via Meta (${whatsapp_message_id})`;
        } catch (error) {
          if (error instanceof AutomationTemplateSendError) throw error;
          if (error instanceof WhatsAppConnectionError)
            throw new AutomationTemplateSendError(
              `template_connection_${error.code}`,
              error.status >= 500 && error.code !== 'invalid_credentials'
            );
          if (error instanceof SendMessageError)
            throw new AutomationTemplateSendError(
              `template_target_${error.code}`,
              error.status >= 500
            );
          if (error instanceof MetaApiError)
            throw new AutomationTemplateSendError(
              `meta_send_failed_http_${error.httpStatus}_code_${error.code ?? 'unknown'}`,
              error.httpStatus >= 500 || error.httpStatus === 429
            );
          throw new AutomationTemplateSendError('template_send_failed', true);
        }
      }
      if (!cfg.template_name)
        throw new Error('send_template needs template_name');
      if (Array.isArray(cfg.variable_mappings)) {
        const resolved = await buildAndResolveMessageVariables({
          accountId: args.automation.account_id,
          contactId: args.contactId,
          reservationId: args.context.reservation?.reservation_id,
          propertyId: args.context.reservation?.property_id,
          mappings: cfg.variable_mappings,
          db,
        });
        if (!resolved.success) {
          const diagnostics = [
            ...resolved.missing.map((item) =>
              [
                `${item.component}/${item.position}`,
                item.variable_key ?? item.custom_field_id,
                item.label,
                item.reason,
              ]
                .filter(Boolean)
                .join(' ')
            ),
            ...resolved.errors.map((item) =>
              [
                item.component && item.position
                  ? `${item.component}/${item.position}`
                  : null,
                item.variable_key ?? item.custom_field_id,
                item.code,
              ]
                .filter(Boolean)
                .join(' ')
            ),
          ];
          throw new Error(
            `template variable resolution failed: ${diagnostics.join('; ')}`
          );
        }
        const messageParams = groupResolvedTemplateParameters(resolved.values);
        const conversationId = await resolveConversationId(args);
        const { whatsapp_message_id } = await engineSendTemplate({
          accountId: args.automation.account_id,
          userId: args.automation.user_id,
          conversationId,
          contactId: args.contactId,
          templateName: cfg.template_name,
          language: cfg.language,
          messageParams,
        });
        return `template sent via Meta (${whatsapp_message_id})`;
      }

      const conversationId = await resolveConversationId(args);
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a);
              const nb = Number(b);
              const aNum = Number.isFinite(na);
              const bNum = Number.isFinite(nb);
              if (aNum && bNum) return na - nb;
              if (aNum) return -1;
              if (bNum) return 1;
              return a.localeCompare(b);
            })
            .map((k) => interpolate(String(cfg.variables![k]), args))
        : [];
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      });
      return `template sent via Meta (${whatsapp_message_id})`;
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig;
      if (!args.contactId || !cfg.tag_id)
        throw new Error('add_tag needs contact + tag_id');
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      });
      if (!added) return `tag ${cfg.tag_id} already present`;

      const depth = getTagChainDepth(args.context);
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          tagId: cfg.tag_id,
          depth,
        });
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`;
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      });
      return `tag ${cfg.tag_id} added and tag_added dispatched`;
    }

    case 'remove_tag': {
      const cfg = step.step_config as TagStepConfig;
      if (!args.contactId || !cfg.tag_id)
        throw new Error('remove_tag needs contact + tag_id');
      await removeContactTag(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      });
      return `tag ${cfg.tag_id} removed`;
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig;
      if (!args.contactId)
        throw new Error('assign_conversation needs a contact');
      let agentId = cfg.agent_id;
      if (cfg.mode === 'round_robin') {
        const { data, error } = await db.rpc(
          'claim_automation_round_robin_assignee',
          {
            p_account_id: args.automation.account_id,
          }
        );
        if (error) throw new Error('round-robin assignment failed');
        agentId = data as string | undefined;
      } else if (agentId) {
        const { data: membership, error } = await db
          .from('account_members')
          .select('user_id')
          .eq('account_id', args.automation.account_id)
          .eq('user_id', agentId)
          .maybeSingle();
        if (error) throw new Error('conversation assignee validation failed');
        if (!membership)
          throw new Error('conversation assignee is not eligible');
      }
      if (!agentId) return 'no agent resolved';
      await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId);
      return `assigned to ${agentId}`;
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig;
      if (!args.contactId)
        throw new Error('update_contact_field needs a contact');
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args);

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length);
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`;
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle();
        if (!field) {
          return `field ${cfg.field} not writable from automations`;
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db.from('contact_custom_values').upsert(
          {
            contact_id: args.contactId,
            custom_field_id: customFieldId,
            value,
          },
          { onConflict: 'contact_id,custom_field_id' }
        );
        return `custom field updated`;
      }

      const allowed = new Set(['name', 'email', 'company']);
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`;
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id);
      return `${cfg.field} updated`;
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig;
      if (!cfg.pipeline_id || !cfg.stage_id)
        throw new Error('create_deal needs pipeline + stage');
      if (!args.contactId) throw new Error('create_deal needs a contact');
      const [contactResult, pipelineResult, stageResult] = await Promise.all([
        db
          .from('contacts')
          .select('id')
          .eq('id', args.contactId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle(),
        db
          .from('pipelines')
          .select('id')
          .eq('id', cfg.pipeline_id)
          .eq('account_id', args.automation.account_id)
          .maybeSingle(),
        db
          .from('pipeline_stages')
          .select('id')
          .eq('id', cfg.stage_id)
          .eq('pipeline_id', cfg.pipeline_id)
          .maybeSingle(),
      ]);
      if (contactResult.error || pipelineResult.error || stageResult.error) {
        throw new Error('create_deal resource validation failed');
      }
      if (!contactResult.data || !pipelineResult.data || !stageResult.data) {
        throw new Error(
          'create_deal resources are not valid for this workspace'
        );
      }
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle();
      const { error: insertError } = await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      });
      if (insertError) throw new Error('create_deal insert failed');
      return 'deal created';
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig;
      if (!cfg.url) throw new Error('send_webhook needs url');
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed');
      }
      const body = cfg.body_template
        ? interpolate(cfg.body_template, args)
        : JSON.stringify(args.context);
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      return `webhook ${res.status}`;
    }

    case 'close_conversation': {
      if (!args.contactId)
        throw new Error('close_conversation needs a contact');
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId);
      return 'conversation closed';
    }

    default:
      return `unknown step: ${step.step_type}`;
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(
  args: ExecuteArgs,
  connectionId?: string
): Promise<string> {
  const fromCtx = args.context.conversation_id;
  if (fromCtx && !connectionId) {
    if (!args.contactId)
      throw new Error('cannot validate conversation: no contact');
    const { data, error } = await supabaseAdmin()
      .from('conversations')
      .select('id')
      .eq('id', fromCtx)
      .eq('account_id', args.automation.account_id)
      .eq('contact_id', args.contactId)
      .maybeSingle();
    if (error) throw new Error('conversation ownership check failed');
    if (!data)
      throw new Error('conversation is not valid for this workspace contact');
    return data.id as string;
  }
  if (!args.contactId)
    throw new Error('cannot resolve conversation: no contact');
  const connection = await resolveWhatsAppConnection(supabaseAdmin(), {
    accountId: args.automation.account_id,
    connectionId: connectionId ?? args.automation.whatsapp_config_id,
    entity: { type: 'automation', id: args.automation.id },
  });
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .eq('whatsapp_config_id', connection.id)
    .maybeSingle();
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  if (data?.id) return data.id as string;
  if (args.triggerEvent === 'tag_added') {
    throw new Error(
      'tag_added automation cannot send: contact has no existing conversation'
    );
  }
  const resolved = await resolveConversationForContact(db, {
    accountId: args.automation.account_id,
    contactId: args.contactId,
    connectionId: connection.id,
  });
  return resolved.conversationId;
}

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]';

/**
 * Whole-word keyword test, behind `match_type: 'word'` (issue #409 — a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Exported for direct unit testing of the escaping / boundary edges.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false
): boolean {
  if (!keyword) return false;
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu'
  );
  return pattern.test(text);
}

export function triggerMatches(
  automation: Automation,
  ctx: AutomationContext | undefined
): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig;
    if (!cfg?.keywords || cfg.keywords.length === 0) return false;
    const text = (ctx?.message_text ?? '').toString();
    if (!text) return false;
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive)
      );
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase();
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase();
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k);
    });
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig;
    const replyId = ctx?.interactive_reply_id;
    if (
      !replyId ||
      !Array.isArray(cfg?.reply_ids) ||
      cfg.reply_ids.length === 0
    ) {
      return false;
    }
    return cfg.reply_ids.includes(replyId);
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig;
    const tagId = ctx?.tag_id;
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId);
  }

  if (
    automation.trigger_type === 'reservation_confirmed' ||
    automation.trigger_type === 'reservation_updated' ||
    automation.trigger_type === 'reservation_cancelled' ||
    automation.trigger_type === 'before_checkin' ||
    automation.trigger_type === 'checkin_day' ||
    automation.trigger_type === 'after_checkout'
  ) {
    return Boolean(
      ctx?.reservation &&
      matchesReservationTriggerConfig(
        automation.trigger_config as PmsTriggerConfig,
        ctx.reservation
      )
    );
  }

  return true;
}

async function evaluateCondition(
  cfg: ConditionStepConfig,
  args: ExecuteArgs
): Promise<boolean> {
  const db = supabaseAdmin();
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false;
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand);
      return (count ?? 0) > 0;
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false;
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle();
      const v = (data as Record<string, unknown> | null)?.[cfg.operand];
      return v != null && String(v) === String(cfg.value ?? '');
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString();
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase());
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-');
      if (!from || !to) return false;
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const f = parse(from);
      const t = parse(to);
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
    }
    case 'property':
      return Boolean(
        args.context.reservation &&
        (args.context.reservation.property_id === (cfg.value ?? cfg.operand) ||
          args.context.reservation.property_name === (cfg.value ?? cfg.operand))
      );
    case 'channel':
      return Boolean(
        args.context.reservation &&
        (args.context.reservation.channel === (cfg.value ?? cfg.operand) ||
          args.context.reservation.channel_name === (cfg.value ?? cfg.operand))
      );
    case 'reservation_status':
      return Boolean(
        args.context.reservation?.reservation_status ===
        (cfg.value ?? cfg.operand)
      );
    default:
      return false;
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs =
    cfg.unit === 'days'
      ? 86_400_000
      : cfg.unit === 'hours'
        ? 3_600_000
        : 60_000;
  return Math.max(1_000, cfg.amount * unitMs);
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.');
    if (ns === 'message' && prop === 'text')
      return String(args.context.message_text ?? '');
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '');
    if (ns === 'reservation' && prop) {
      return String(
        args.context.reservation?.[
          prop as keyof ReservationAutomationContext
        ] ?? ''
      );
    }
    return '';
  });
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
  triggerJobExecution = false
) {
  if (!logId) return;
  const db = supabaseAdmin();
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single();
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ??
      []),
    ...newItems,
  ];
  const update: Record<string, unknown> = { steps_executed: merged };
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status;
    if (triggerJobExecution) {
      update.trigger_job_execution_state =
        status === 'failed' ? 'failed' : 'completed';
    }
  }
  if (errorMessage) update.error_message = errorMessage;
  await db.from('automation_logs').update(update).eq('id', logId);
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
  triggerJobExecution = false
) {
  if (!logId) return;
  await supabaseAdmin()
    .from('automation_logs')
    .update({
      status,
      error_message: errorMessage,
      ...(triggerJobExecution
        ? {
            trigger_job_execution_state:
              status === 'failed' ? 'failed' : 'completed',
          }
        : {}),
    })
    .eq('id', logId);
}

async function recordWaitContinuationCompleted(
  args: ExecuteArgs
): Promise<void> {
  if (!args.continuationId) return;
  if (!args.logId)
    throw new Error('wait continuation is missing its automation log identity');
  const { data, error } = await supabaseAdmin().rpc(
    'complete_automation_wait_continuation',
    {
      p_log_id: args.logId,
      p_pending_execution_id: args.continuationId,
      p_account_id: args.automation.account_id,
      p_automation_id: args.automation.id,
    }
  );
  if (error || data !== true) {
    throw new Error('wait continuation completion could not be recorded');
  }
}

async function markPending(id: string, status: 'done') {
  const { error } = await supabaseAdmin()
    .from('automation_pending_executions')
    .update({
      status,
      processing_started_at: null,
      next_attempt_at: null,
      last_error: null,
    })
    .eq('id', id);
  if (error) throw new Error(`cannot mark pending execution ${status}`);
}
