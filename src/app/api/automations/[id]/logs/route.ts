import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  type ActivityRetryState,
  type ActivityFailureReason,
  type RetryActivityLog,
  validExecutionId,
} from '@/lib/automations/manual-retry';
import type { AutomationLog } from '@/types';
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let account;
  try {
    account = await getCurrentAccount();
  } catch (error) {
    return toErrorResponse(error);
  }
  const { id } = await params;
  if (!validExecutionId(id))
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const db = supabaseAdmin();
    const { data: automation, error: autError } = await db
      .from('automations')
      .select('id,name,trigger_type')
      .eq('id', id)
      .eq('account_id', account.accountId)
      .maybeSingle();
    if (autError) throw new Error('lookup_failed');
    if (!automation)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { data: logs, error } = await db
      .from('automation_logs')
      .select(
        `id,status,trigger_event,created_at,trigger_job_id,trigger_job_attempt_count,trigger_job_execution_state,error_message,steps_executed,
        contact:contacts(name,phone),
        trigger_job:automation_trigger_jobs!automation_logs_trigger_job_account_fkey(status,attempt_count,
          reservation:pms_reservations!automation_trigger_jobs_reservation_account_fkey(reservation_code))`
      )
      .eq('automation_id', id)
      .eq('account_id', account.accountId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error('lookup_failed');
    const rows = (logs ?? []) as unknown as (AutomationLog & {
      trigger_job?: {
        status: string;
        attempt_count: number;
        reservation?: { reservation_code: string | null } | null;
      } | null;
    })[];
    const ids = rows.filter((log) => log.trigger_job_id).map((log) => log.id);
    const eligibility = new Map<string, ActivityRetryState>();
    if (ids.length && hasMinRole(account.role, 'agent')) {
      const { data: states, error: stateError } = await db.rpc(
        'get_pms_automation_retry_states',
        {
          p_account_id: account.accountId,
          p_log_ids: ids,
        }
      );
      if (stateError) throw new Error('lookup_failed');
      for (const row of states ?? []) {
        eligibility.set(
          row.log_id,
          ['eligible', 'already_completed', 'already_retried'].includes(
            row.retry_state
          )
            ? row.retry_state
            : 'not_eligible'
        );
      }
    }
    // Whitelist the host-facing response. Raw errors and step details stay in the database.
    const activity: RetryActivityLog[] = rows.map((log) => ({
      id: log.id,
      status: log.status,
      trigger_event: log.trigger_event,
      created_at: log.created_at,
      trigger_job_id: log.trigger_job_id,
      trigger_job_attempt_count: log.trigger_job_attempt_count,
      trigger_job_execution_state: log.trigger_job_execution_state,
      contact: log.contact
        ? {
            name: log.contact.name ?? null,
            phone: log.contact.phone ?? null,
          }
        : null,
      reservation_reference:
        log.trigger_job?.reservation?.reservation_code ?? null,
      job_status: log.trigger_job?.status,
      job_attempt_count: log.trigger_job?.attempt_count,
      ...(log.status === 'failed'
        ? {
            failure_reason: failureReason(
              log.error_message,
              log.steps_executed?.find((step) => step.status === 'failed')
                ?.step_type
            ),
          }
        : {}),
      steps_executed: (log.steps_executed ?? []).map((step) => ({
        step_type: step.step_type,
        status: step.status,
        ...(step.status === 'failed'
          ? { failure_reason: failureReason(step.detail, step.step_type) }
          : {}),
      })),
      ...(log.trigger_job_id
        ? { manual_retry_state: eligibility.get(log.id) ?? 'not_eligible' }
        : {}),
    }));
    return NextResponse.json({ automation, logs: activity });
  } catch {
    return NextResponse.json(
      { error: 'Unable to load execution history.' },
      { status: 503 }
    );
  }
}

/** Presentation only: these categories never participate in retry eligibility. */
function failureReason(
  error: string | null | undefined,
  stepType?: string
): ActivityFailureReason {
  const code = (error ?? '').split(';')[0].trim();
  if (
    code.startsWith('template_connection_') ||
    code === 'template_connection_invalid'
  )
    return 'connection';
  if (
    [
      'template_not_found',
      'template_not_owned',
      'template_not_sendable',
      'template_not_configured',
      'invalid_semantic_mapping',
      'unsupported_template_component',
      'provider_payload_invalid',
    ].includes(code)
  )
    return 'template';
  if (
    [
      'variable_missing',
      'variable_unsupported',
      'runtime_provider_failure',
      'runtime_resolution_failure',
    ].includes(code)
  )
    return 'variables';
  if (
    code.startsWith('template_target_') ||
    /^(send_template|send_message|send_buttons|send_list) needs a contact$/.test(
      code
    )
  )
    return 'recipient';
  if (code === 'reservation_context_unavailable') return 'reservation';
  if (
    stepType === 'send_template' ||
    code === 'template_send_failed' ||
    /^meta_send_failed_http_/.test(code)
  )
    return 'templateSend';
  return 'generic';
}
