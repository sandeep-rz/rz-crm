import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  resolveWhatsAppConnection,
  WhatsAppConnectionError,
} from '@/lib/whatsapp/connection-resolver';
import { getTemplate } from '@/lib/automations/templates';
import {
  insertSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree';
import {
  validateStepsForActivation,
  validateTemplateActions,
  validateTriggerForActivation,
  validatePmsPropertyTimezonesForActivation,
  validateWhatsAppConnectionForActivation,
} from '@/lib/automations/validate';
import { backfillPmsAutomationSchedules } from '@/lib/automations/pms-schedule-backfill';
import { isPmsScheduledAutomationTrigger } from '@/lib/automations/pms-trigger-schema';

async function rollbackCreatedAutomation(
  admin: ReturnType<typeof supabaseAdmin>,
  automationId: string,
  accountId: string
): Promise<'deleted' | 'paused'> {
  const { error: deleteError } = await admin
    .from('automations')
    .delete()
    .eq('id', automationId)
    .eq('account_id', accountId);
  if (!deleteError) return 'deleted';

  const { data: paused, error: pauseError } = await admin
    .from('automations')
    .update({ is_active: false })
    .eq('id', automationId)
    .eq('account_id', accountId)
    .select('id, is_active')
    .maybeSingle();
  if (pauseError || !paused || paused.is_active !== false) {
    throw new Error(
      'Automation creation cleanup failed and its inactive state could not be verified.'
    );
  }
  return 'paused';
}

export async function GET() {
  let account;
  try {
    account = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const { data, error } = await account.supabase
    .from('automations')
    .select('*')
    .eq('account_id', account.accountId)
    .order('created_at', { ascending: false });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ automations: data ?? [] });
}

export async function POST(request: Request) {
  // Creating an automation is a write — the RLS automations_insert policy
  // requires `agent`, but this route inserts via the service-role client
  // which bypasses RLS, so the role must be enforced here.
  let account;
  try {
    account = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }
  const accountId = account.accountId;

  const body = await request.json().catch(() => null);
  if (!body)
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const {
    name,
    description,
    trigger_type,
    trigger_config,
    is_active,
    steps,
    template,
  } = body;

  let effectiveSteps: BuilderStepInput[] | undefined = steps;
  let effectiveName = name;
  let effectiveDescription = description;
  let effectiveTriggerType = trigger_type;
  let effectiveTriggerConfig = trigger_config;

  if (template && (!steps || steps.length === 0)) {
    const t = getTemplate(template);
    if (t) {
      effectiveName = effectiveName ?? t.name;
      effectiveDescription = effectiveDescription ?? t.description;
      effectiveTriggerType = effectiveTriggerType ?? t.trigger_type;
      effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config;
      effectiveSteps = t.steps as unknown as BuilderStepInput[];
    }
  }

  if (!effectiveName || !effectiveTriggerType) {
    return NextResponse.json(
      { error: 'name and trigger_type are required' },
      { status: 400 }
    );
  }

  const templateIssues = validateTemplateActions(effectiveSteps ?? []);
  if (templateIssues.length)
    return NextResponse.json(
      { error: 'Invalid automation template action', issues: templateIssues },
      { status: 400 }
    );

  const admin = supabaseAdmin();
  const stageTimingActivation =
    !!is_active && isPmsScheduledAutomationTrigger(effectiveTriggerType);
  let whatsappConfigId: string | null = null;
  if (
    body.whatsapp_config_id !== undefined &&
    body.whatsapp_config_id !== null
  ) {
    if (
      typeof body.whatsapp_config_id !== 'string' ||
      body.whatsapp_config_id.trim() === ''
    ) {
      return NextResponse.json(
        { error: 'whatsapp_config_id must be a non-empty string or null' },
        { status: 400 }
      );
    }
    try {
      const connection = await resolveWhatsAppConnection(admin, {
        accountId,
        connectionId: body.whatsapp_config_id,
      });
      whatsappConfigId = connection.id;
    } catch (error) {
      if (error instanceof WhatsAppConnectionError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status }
        );
      }
      throw error;
    }
  }

  // Block activation of a clearly broken automation up-front instead of
  // letting every trigger silently produce a failed log row. Drafts
  // (is_active=false) are allowed to be incomplete so users can save
  // progress mid-build.
  if (is_active) {
    const timezoneIssues = await validatePmsPropertyTimezonesForActivation(
      admin,
      accountId,
      effectiveTriggerType,
      effectiveTriggerConfig ?? {}
    );
    const issues = [
      ...validateTriggerForActivation(
        effectiveTriggerType,
        effectiveTriggerConfig ?? {}
      ),
      ...timezoneIssues,
      ...validateStepsForActivation(
        (effectiveSteps ?? []) as unknown as {
          step_type: string;
          step_config: Record<string, unknown>;
        }[]
      ),
      ...validateWhatsAppConnectionForActivation(
        (effectiveSteps ?? []) as unknown as {
          step_type: string;
          step_config: Record<string, unknown>;
        }[],
        whatsappConfigId
      ),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot activate automation with invalid configuration',
          issues,
        },
        { status: 400 }
      );
    }
  }

  const { data: automation, error: insertErr } = await admin
    .from('automations')
    .insert({
      user_id: account.userId,
      account_id: accountId,
      whatsapp_config_id: whatsappConfigId,
      name: effectiveName,
      description: effectiveDescription ?? null,
      trigger_type: effectiveTriggerType,
      trigger_config: effectiveTriggerConfig ?? {},
      // Timing activations remain inert until every existing reservation batch
      // has been reconciled. A partial backfill can therefore never execute.
      is_active: stageTimingActivation ? false : !!is_active,
    })
    .select()
    .single();

  if (insertErr || !automation) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'insert failed' },
      { status: 500 }
    );
  }

  if (effectiveSteps && effectiveSteps.length > 0) {
    const err = await insertSteps(automation.id, effectiveSteps);
    if (err) {
      try {
        const cleanup = await rollbackCreatedAutomation(
          admin,
          automation.id,
          accountId
        );
        return NextResponse.json(
          {
            error: 'Automation steps could not be saved.',
            code: 'automation_creation_failed',
            automation_id: cleanup === 'paused' ? automation.id : undefined,
            automation_paused: cleanup === 'paused',
          },
          { status: 500 }
        );
      } catch (cleanupError) {
        return NextResponse.json(
          {
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : 'Automation creation cleanup failed.',
            code: 'automation_cleanup_failed',
          },
          { status: 500 }
        );
      }
    }
  }

  let responseAutomation = automation;
  if (stageTimingActivation) {
    try {
      await backfillPmsAutomationSchedules(automation.id, {
        allowInactiveActivation: true,
      });
      const { data: activated, error: activationError } = await admin
        .from('automations')
        .update({ is_active: true })
        .eq('id', automation.id)
        .eq('account_id', accountId)
        .eq('is_active', false)
        .select()
        .single();
      if (activationError || !activated) {
        throw new Error(
          'The completed reservation schedule could not be activated.'
        );
      }
      responseAutomation = activated;
    } catch (error) {
      try {
        const cleanup = await rollbackCreatedAutomation(
          admin,
          automation.id,
          accountId
        );
        return NextResponse.json(
          {
            error:
              "We couldn't create the future reservation schedule. No automation was activated.",
            detail: error instanceof Error ? error.message : undefined,
            code: 'pms_schedule_creation_failed',
            automation_id: cleanup === 'paused' ? automation.id : undefined,
            automation_paused: cleanup === 'paused',
          },
          { status: 500 }
        );
      } catch (cleanupError) {
        return NextResponse.json(
          {
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : 'Automation creation cleanup failed.',
            code: 'automation_cleanup_failed',
          },
          { status: 500 }
        );
      }
    }
  }

  return NextResponse.json({ automation: responseAutomation }, { status: 201 });
}
