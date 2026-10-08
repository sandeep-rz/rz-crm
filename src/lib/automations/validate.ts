import type { SupabaseClient } from '@supabase/supabase-js';

import type { AutomationTriggerType, PmsTriggerConfig } from '@/types';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { isWhatsAppSendStep } from './action-schema';
import {
  isPmsAutomationTrigger,
  isPmsScheduledAutomationTrigger,
  isValidIanaTimeZone,
  PMS_FILTER_CONFIG_FIELDS,
  PMS_LOCAL_TIME_PATTERN,
  PMS_OFFSET_DAYS_MAX,
  PMS_OFFSET_DAYS_MIN,
} from './pms-trigger-schema';

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string;
  message: string;
}

interface StepLike {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: StepLike[]; no?: StepLike[] };
}

export function validateStepsForActivation(
  steps: StepLike[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    });
    return issues;
  }
  walk(steps, '', issues);
  return issues;
}

/** Template actions use the same contract for drafts, activation and execution. */
export function validateTemplateActions(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(steps))
    return [{ path: 'steps', message: 'steps must be an array' }];
  walk(steps, '', issues, true);
  return issues;
}

/**
 * WhatsApp is an action dependency, not an automation-wide dependency.
 * Conditions may contain send actions in either branch, so inspect the full
 * tree before allowing activation without a selected connection.
 */
export function stepsRequireWhatsAppConnection(steps: StepLike[]): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((step) => {
    if (isWhatsAppSendStep(step.step_type)) return true;
    if (step.step_type !== 'condition' || !step.branches) return false;
    return (
      stepsRequireWhatsAppConnection(step.branches.yes ?? []) ||
      stepsRequireWhatsAppConnection(step.branches.no ?? [])
    );
  });
}

export function validateWhatsAppConnectionForActivation(
  steps: StepLike[],
  whatsappConfigId: string | null | undefined
): ValidationIssue[] {
  if (stepsRequireWhatsAppConnection(steps) && !nonEmpty(whatsappConfigId)) {
    return [
      {
        path: 'whatsapp_config_id',
        message: 'a WhatsApp connection is required for WhatsApp send actions',
      },
    ];
  }
  return [];
}

function walk(
  steps: StepLike[],
  prefix: string,
  issues: ValidationIssue[],
  templatesOnly = false
): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`;
    if (!templatesOnly || s.step_type === 'send_template')
      validateOne(s, path, issues);
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes)
        walk(s.branches.yes, `${path}.yes.`, issues, templatesOnly);
      if (s.branches.no)
        walk(s.branches.no, `${path}.no.`, issues, templatesOnly);
    }
  });
}

function validateOne(
  step: StepLike,
  path: string,
  issues: ValidationIssue[]
): void {
  const c = step.step_config ?? {};
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({
          path: `${path}.text`,
          message: 'message text is required',
        });
      }
      break;
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c);
      if (!result.ok) {
        issues.push({ path: `${path}.interactive`, message: result.error });
      }
      break;
    }
    case 'send_template':
      if (
        typeof c.template_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          c.template_id
        )
      ) {
        issues.push({
          path: `${path}.template_id`,
          message: 'valid template id is required',
        });
      }
      for (const field of ['variable_mappings', 'variables']) {
        if (Object.prototype.hasOwnProperty.call(c, field)) {
          issues.push({
            path: `${path}.${field}`,
            message:
              'template variables must be configured on the template, not the automation action',
          });
        }
      }
      break;
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' });
      }
      break;
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        });
      }
      break;
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({
          path: `${path}.field`,
          message: 'field name is required',
        });
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({
          path: `${path}.value`,
          message: 'field value is required',
        });
      }
      break;
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({
          path: `${path}.pipeline_id`,
          message: 'pipeline is required',
        });
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' });
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' });
      }
      break;
    case 'wait':
      if (
        typeof c.amount !== 'number' ||
        !Number.isFinite(c.amount) ||
        c.amount <= 0
      ) {
        issues.push({
          path: `${path}.amount`,
          message: 'wait amount must be greater than 0',
        });
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
        });
      }
      break;
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({
          path: `${path}.subject`,
          message: 'condition subject is required',
        });
      }
      if (!nonEmpty(c.operand)) {
        issues.push({
          path: `${path}.operand`,
          message: 'condition operand is required',
        });
      }
      break;
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({
          path: `${path}.url`,
          message: 'webhook URL is required',
        });
        break;
      }
      try {
        const u = new URL(String(c.url));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          });
        }
      } catch {
        issues.push({
          path: `${path}.url`,
          message: 'webhook URL is not a valid URL',
        });
      }
      break;
    case 'close_conversation':
      // No config required.
      break;
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` });
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>;

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords;
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({
        path: 'trigger.keywords',
        message: 'at least one keyword is required',
      });
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.keywords',
        message: 'keywords cannot be empty strings',
      });
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (
      cfg.match_type != null &&
      cfg.match_type !== 'exact' &&
      cfg.match_type !== 'contains' &&
      cfg.match_type !== 'word'
    ) {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact", "contains" or "word"',
      });
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({
        path: 'trigger.schedule',
        message: 'schedule is required',
      });
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' });
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
      });
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'reply ids cannot be empty strings',
      });
    }
  } else if (isPmsAutomationTrigger(triggerType)) {
    for (const field of PMS_FILTER_CONFIG_FIELDS) {
      if (
        cfg[field] != null &&
        (!Array.isArray(cfg[field]) ||
          (cfg[field] as unknown[]).some((value) => !nonEmpty(value)))
      ) {
        issues.push({
          path: `trigger.${field}`,
          message: `${field} must contain non-empty strings`,
        });
      }
    }
    if (isPmsScheduledAutomationTrigger(triggerType)) {
      // Explicit timezones are retained for compatibility with definitions
      // saved before properties carried their own timezone. New definitions
      // omit this field and are checked against pms_properties by the API.
      if (cfg.timezone != null) {
        if (!isValidIanaTimeZone(cfg.timezone)) {
          issues.push({
            path: 'trigger.timezone',
            message: 'timezone must be a valid IANA timezone',
          });
        }
      }
      if (
        typeof cfg.local_time !== 'string' ||
        !PMS_LOCAL_TIME_PATTERN.test(cfg.local_time)
      ) {
        issues.push({
          path: 'trigger.local_time',
          message: 'local time must use HH:mm',
        });
      }
    }
    if (triggerType === 'before_checkin') {
      if (
        !Number.isInteger(cfg.days_before) ||
        Number(cfg.days_before) < PMS_OFFSET_DAYS_MIN ||
        Number(cfg.days_before) > PMS_OFFSET_DAYS_MAX
      ) {
        issues.push({
          path: 'trigger.days_before',
          message: 'days before must be an integer from 0 to 365',
        });
      }
    }
    if (triggerType === 'after_checkout') {
      if (
        !Number.isInteger(cfg.days_after) ||
        Number(cfg.days_after) < PMS_OFFSET_DAYS_MIN ||
        Number(cfg.days_after) > PMS_OFFSET_DAYS_MAX
      ) {
        issues.push({
          path: 'trigger.days_after',
          message: 'days after must be an integer from 0 to 365',
        });
      }
    }
  }

  return issues;
}

/**
 * Activation-time property check for new reservation-relative schedules.
 * Kept separate from the synchronous shape validator because it must enforce
 * account-scoped database state. Runtime scheduling remains defensive and
 * declines to create a job when the canonical property has no timezone.
 */
export async function validatePmsPropertyTimezonesForActivation(
  db: SupabaseClient,
  accountId: string,
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown
): Promise<ValidationIssue[]> {
  if (!isPmsScheduledAutomationTrigger(triggerType)) return [];

  const config = (triggerConfig ?? {}) as PmsTriggerConfig;
  if (nonEmpty(config.timezone)) return [];

  const propertyIds = Array.isArray(config.property_ids)
    ? config.property_ids
    : config.property_id
      ? [config.property_id]
      : [];

  let query = db
    .from('pms_properties')
    .select('id, name, timezone, status')
    .eq('account_id', accountId);
  query =
    propertyIds.length > 0
      ? query.in('id', propertyIds)
      : query.eq('status', 'active');

  const { data, error } = await query;
  if (error) {
    return [
      {
        path: 'trigger.property_ids',
        message: 'Property timezones could not be verified. Try again.',
      },
    ];
  }

  const rows = data ?? [];
  if (propertyIds.length > 0 && rows.length !== new Set(propertyIds).size) {
    return [
      {
        path: 'trigger.property_ids',
        message: 'One or more selected properties are no longer available.',
      },
    ];
  }
  if (rows.length === 0) {
    return [
      {
        path: 'trigger.property_ids',
        message:
          'Connect at least one PMS property before activating this schedule.',
      },
    ];
  }

  const missing = rows.filter((row) => !isValidIanaTimeZone(row.timezone));
  if (missing.length === 0) return [];
  const names = missing
    .slice(0, 3)
    .map((row) => (nonEmpty(row.name) ? row.name : 'Unnamed property'))
    .join(', ');
  return [
    {
      path: 'trigger.property_ids',
      message: `Set the property timezone in RZ PMS before activating this schedule: ${names}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}.`,
    },
  ];
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}
