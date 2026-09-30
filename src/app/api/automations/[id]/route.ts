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
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
  validatePmsPropertyTimezonesForActivation,
  validateWhatsAppConnectionForActivation,
} from '@/lib/automations/validate';
import {
  backfillPmsAutomationSchedules,
  cancelFuturePmsAutomationSchedules,
} from '@/lib/automations/pms-schedule-backfill';
import { isPmsScheduledAutomationTrigger } from '@/lib/automations/pms-trigger-schema';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function ensureAutomationPaused(
  admin: ReturnType<typeof supabaseAdmin>,
  automationId: string,
  accountId: string
): Promise<void> {
  const { data, error } = await admin
    .from('automations')
    .update({ is_active: false })
    .eq('id', automationId)
    .eq('account_id', accountId)
    .select('id, is_active')
    .maybeSingle();
  if (error || !data || data.is_active !== false) {
    throw new Error(
      'The automation schedule update failed and its paused state could not be verified.'
    );
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let account;
  try {
    account = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', account.accountId)
    .maybeSingle();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  if (!automation)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const steps = await loadStepsTree(id);
  return NextResponse.json({ automation, steps });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Editing an automation is a write — the RLS automations_update policy
  // requires `agent`, but this route mutates via the service-role client
  // which bypasses RLS, so enforce the role here.
  let account;
  try {
    account = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body)
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const admin = supabaseAdmin();

  // Ownership check before we touch anything. Load the fields we need
  // to compute the post-patch "effective" state for validation.
  const { data: existing } = await admin
    .from('automations')
    .select(
      'id, user_id, account_id, whatsapp_config_id, is_active, trigger_type, trigger_config'
    )
    .eq('id', id)
    .maybeSingle();
  if (!existing || existing.account_id !== account.accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
  ] as const) {
    if (k in body) update[k] = body[k];
  }
  if ('whatsapp_config_id' in body) {
    if (body.whatsapp_config_id === null) {
      update.whatsapp_config_id = null;
    } else if (
      typeof body.whatsapp_config_id === 'string' &&
      body.whatsapp_config_id.trim() !== ''
    ) {
      try {
        const connection = await resolveWhatsAppConnection(admin, {
          accountId: existing.account_id,
          connectionId: body.whatsapp_config_id,
        });
        update.whatsapp_config_id = connection.id;
      } catch (error) {
        if (error instanceof WhatsAppConnectionError) {
          return NextResponse.json(
            { error: error.message },
            { status: error.status }
          );
        }
        throw error;
      }
    } else {
      return NextResponse.json(
        { error: 'whatsapp_config_id must be a non-empty string or null' },
        { status: 400 }
      );
    }
  }

  // If this PATCH leaves the automation active (either explicitly
  // activating it OR editing an already-active one), validate the
  // merged configuration first. Activation is the natural gate — drafts
  // are still allowed to be incomplete.
  const willBeActive =
    typeof update.is_active === 'boolean'
      ? update.is_active
      : existing.is_active;
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ??
      existing.trigger_type) as string;
    const mergedTriggerConfig =
      update.trigger_config ?? existing.trigger_config;
    const mergedSteps = Array.isArray(body.steps)
      ? (body.steps as {
          step_type: string;
          step_config: Record<string, unknown>;
        }[])
      : await loadStepsTree(id);
    const mergedWhatsappConfigId =
      'whatsapp_config_id' in update
        ? (update.whatsapp_config_id as string | null)
        : (existing.whatsapp_config_id as string | null);
    const timezoneIssues = await validatePmsPropertyTimezonesForActivation(
      admin,
      existing.account_id,
      mergedTriggerType,
      mergedTriggerConfig
    );
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...timezoneIssues,
      ...validateStepsForActivation(mergedSteps),
      ...validateWhatsAppConnectionForActivation(
        mergedSteps,
        mergedWhatsappConfigId
      ),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 }
      );
    }
  }

  const nextTriggerType = (update.trigger_type ??
    existing.trigger_type) as string;
  const nextTriggerConfig = update.trigger_config ?? existing.trigger_config;
  const wasActiveTiming =
    existing.is_active &&
    isPmsScheduledAutomationTrigger(existing.trigger_type as string);
  const isActiveTiming =
    willBeActive && isPmsScheduledAutomationTrigger(nextTriggerType);
  const timingDefinitionChanged =
    existing.trigger_type !== nextTriggerType ||
    stableJson(existing.trigger_config) !== stableJson(nextTriggerConfig);
  const stageTimingRebuild =
    isActiveTiming && (!wasActiveTiming || timingDefinitionChanged);

  if (stageTimingRebuild) {
    // Keep workers and concurrent webhook scheduling behind a hard inactive
    // boundary until cancellation and every backfill batch have succeeded.
    update.is_active = false;
  }

  if (Object.keys(update).length > 0) {
    const { error: updErr } = await admin
      .from('automations')
      .update(update)
      .eq('id', id)
      .eq('account_id', account.accountId);
    if (updErr)
      return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  if (Array.isArray(body.steps)) {
    const err = await replaceSteps(id, body.steps as BuilderStepInput[]);
    if (err) {
      if (stageTimingRebuild) {
        try {
          await ensureAutomationPaused(admin, id, existing.account_id);
        } catch (pauseError) {
          return NextResponse.json(
            {
              error:
                pauseError instanceof Error
                  ? pauseError.message
                  : 'The automation could not be safely paused.',
              code: 'pms_schedule_pause_unverified',
              automation_paused: false,
            },
            { status: 500 }
          );
        }
        return NextResponse.json(
          {
            error:
              "We couldn't update the future reservation schedule. The automation has been paused to prevent incorrect actions. Review it and activate it again.",
            detail: err,
            code: 'pms_schedule_update_failed',
            automation_paused: true,
          },
          { status: 500 }
        );
      }
      return NextResponse.json({ error: err }, { status: 500 });
    }
  }

  try {
    if (wasActiveTiming && (!isActiveTiming || timingDefinitionChanged)) {
      await cancelFuturePmsAutomationSchedules({
        automationId: id,
        accountId: existing.account_id,
        reason: isActiveTiming
          ? 'Automation timing configuration changed.'
          : 'Automation was deactivated or changed trigger type.',
      });
    }
    if (stageTimingRebuild) {
      await backfillPmsAutomationSchedules(id, {
        allowInactiveActivation: true,
      });
      const { data: activated, error: activationError } = await admin
        .from('automations')
        .update({ is_active: true })
        .eq('id', id)
        .eq('account_id', existing.account_id)
        .eq('is_active', false)
        .select('id, is_active')
        .maybeSingle();
      if (activationError || !activated || activated.is_active !== true) {
        throw new Error(
          'The completed reservation schedule could not be activated.'
        );
      }
    }
  } catch (error) {
    // A multi-batch backfill can fail after writing an earlier batch. Keep
    // execution safe and make the next explicit activation retry the full
    // idempotent backfill instead of leaving a partially scheduled active
    // automation.
    const mustPause = stageTimingRebuild || !willBeActive;
    if (mustPause) {
      try {
        await ensureAutomationPaused(admin, id, existing.account_id);
      } catch (pauseError) {
        return NextResponse.json(
          {
            error:
              pauseError instanceof Error
                ? pauseError.message
                : 'The automation could not be safely paused.',
            code: 'pms_schedule_pause_unverified',
            automation_paused: false,
          },
          { status: 500 }
        );
      }
    }
    return NextResponse.json(
      {
        error: mustPause
          ? "We couldn't update the future reservation schedule. The automation has been paused to prevent incorrect actions. Review it and activate it again."
          : error instanceof Error
            ? error.message
            : 'PMS schedule lifecycle update failed.',
        detail: error instanceof Error ? error.message : undefined,
        code: 'pms_schedule_update_failed',
        automation_paused: mustPause,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Deleting an automation is a write — enforce `agent` (the service-role
  // client below bypasses the agent-gated automations_delete RLS).
  let account;
  try {
    account = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { error } = await supabaseAdmin()
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('account_id', account.accountId);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
