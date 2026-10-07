'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Clock,
  Minus,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { ExecutionRetry } from '@/components/automations/execution-retry';
import type { RetryActivityLog } from '@/lib/automations/manual-retry';
import type { Automation } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRelative, isKnownTrigger } from '@/lib/automations/trigger-meta';

export default function AutomationLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { accountId } = useAuth();
  const [revision, setRevision] = useState(0);
  const t = useTranslations('Automations.logs');
  const tTriggers = useTranslations('Automations.builder.triggers');
  const format = useFormatter();
  const tRelative = useTranslations('Automations.relative');

  const [automation, setAutomation] = useState<Pick<
    Automation,
    'id' | 'name' | 'trigger_type'
  > | null>(null);
  const [logs, setLogs] = useState<RetryActivityLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openLogId, setOpenLogId] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/automations/${id}/logs`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(t('loadError'));
        const body = await response.json();
        if (!controller.signal.aborted) {
          setAutomation(body.automation as Automation);
          setLogs(body.logs as RetryActivityLog[]);
          setError(null);
        }
      } catch {
        if (!controller.signal.aborted) setError(t('loadError'));
      }
    }
    void load();
    return () => controller.abort();
  }, [id, accountId, revision, t]);

  useEffect(() => {
    if (
      !logs?.some(
        (log) =>
          log.trigger_job_execution_state === 'processing' ||
          log.job_status === 'scheduled' ||
          log.job_status === 'processing' ||
          log.status === 'partial'
      )
    )
      return;
    const timer = setInterval(() => setRevision((value) => value + 1), 10000);
    return () => clearInterval(timer);
  }, [logs]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => router.push('/automations')}>
          {t('back')}
        </Button>
      </div>
    );
  }

  if (!automation || logs === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push('/automations')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 items-center justify-center rounded-md transition-colors"
          aria-label={t('backAria')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-foreground text-2xl font-bold">
            {automation.name}
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">{t('title')}</p>
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="border-border bg-card/40 flex h-48 flex-col items-center justify-center rounded-xl border border-dashed">
          <p className="text-foreground text-sm">{t('emptyTitle')}</p>
          <p className="text-muted-foreground mt-1 text-xs">{t('emptyDesc')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {logs.map((log) => {
            const isOpen = openLogId === log.id;
            const status =
              log.trigger_job_execution_state === 'processing'
                ? 'processing'
                : log.status === 'partial'
                  ? 'queued'
                  : log.status === 'success'
                    ? 'completed'
                    : 'failed';
            // A queued retry is separate from the failed historical attempt.
            const retryQueued =
              log.job_status === 'scheduled' &&
              log.job_attempt_count === log.trigger_job_attempt_count;
            const retryState =
              log.manual_retry_state === 'already_retried' && !retryQueued
                ? 'not_eligible'
                : log.manual_retry_state;
            const trigger = isKnownTrigger(log.trigger_event)
              ? tTriggers(`${log.trigger_event}.label`)
              : t('automationTriggered');
            return (
              <li
                key={log.id}
                className="border-border bg-card overflow-hidden rounded-xl border shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`timeline-${log.id}`}
                    onClick={() => setOpenLogId(isOpen ? null : log.id)}
                    className="focus-visible:ring-ring flex min-w-0 flex-1 items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2"
                  >
                    {isOpen ? (
                      <ChevronDown className="text-muted-foreground mt-1 h-4 w-4 shrink-0" />
                    ) : (
                      <ChevronRight className="text-muted-foreground mt-1 h-4 w-4 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-foreground truncate text-sm font-semibold">
                          {automation.name}
                        </span>
                        <StatusBadge status={status} t={t} />
                        {log.trigger_job_attempt_count != null && (
                          <Badge variant="outline">
                            {t('attempt', {
                              count: log.trigger_job_attempt_count,
                            })}
                          </Badge>
                        )}
                        {retryQueued && retryState !== 'already_retried' && (
                          <Badge variant="secondary">{t('retryQueued')}</Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <span>{trigger}</span>
                        {log.contact && (
                          <span className="text-foreground">
                            {log.contact.name ||
                              log.contact.phone ||
                              t('unknownContact')}
                          </span>
                        )}
                        {log.reservation_reference && (
                          <span>
                            {t('reservation', {
                              reference: log.reservation_reference,
                            })}
                          </span>
                        )}
                      </div>
                      <time
                        dateTime={log.created_at}
                        className="text-muted-foreground block text-xs"
                      >
                        {format.dateTime(new Date(log.created_at), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                        <span className="ml-2">
                          · {formatRelative(log.created_at, tRelative)}
                        </span>
                      </time>
                      {status === 'failed' && (
                        <p className="text-destructive text-xs">
                          {t(`failure.${log.failure_reason ?? 'generic'}`)}
                        </p>
                      )}
                    </div>
                  </button>
                  <ExecutionRetry
                    key={`${log.id}:${log.job_status}:${log.job_attempt_count}`}
                    logId={log.id}
                    state={retryState}
                    onQueued={() => {
                      setLogs(
                        (current) =>
                          current?.map((row) =>
                            row.id === log.id
                              ? {
                                  ...row,
                                  manual_retry_state: 'already_retried',
                                  job_status: 'scheduled',
                                  job_attempt_count:
                                    row.trigger_job_attempt_count ?? undefined,
                                }
                              : row
                          ) ?? null
                      );
                      setRevision((value) => value + 1);
                    }}
                  />
                </div>
                {isOpen && (
                  <div
                    id={`timeline-${log.id}`}
                    className="border-border bg-muted/20 border-t px-5 py-4 sm:pl-11"
                  >
                    <p className="text-muted-foreground mb-3 text-xs font-medium">
                      {t('timeline')}
                    </p>
                    <ol className="space-y-3">
                      <StepRow
                        label={t('automationTriggered')}
                        status="success"
                      />
                      {log.steps_executed.map((step, index) => (
                        <StepRow
                          key={index}
                          status={step.status}
                          label={
                            t.has(
                              `timelineSteps.${step.step_type}.${step.status}`
                            )
                              ? t(
                                  `timelineSteps.${step.step_type}.${step.status}`
                                )
                              : t(`timelineSteps.other.${step.status}`)
                          }
                          reason={
                            step.status === 'failed'
                              ? t(`failure.${step.failure_reason ?? 'generic'}`)
                              : undefined
                          }
                        />
                      ))}
                      {status === 'processing' && (
                        <StepRow label={t('inProgress')} status="processing" />
                      )}
                      {status === 'queued' && (
                        <StepRow label={t('waiting')} status="queued" />
                      )}
                      {log.steps_executed.length === 0 &&
                        status === 'failed' && (
                          <StepRow
                            label={t('executionFailed')}
                            status="failed"
                            reason={t(
                              `failure.${log.failure_reason ?? 'generic'}`
                            )}
                          />
                        )}
                    </ol>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: 'completed' | 'failed' | 'processing' | 'queued';
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Badge
      variant={status === 'failed' ? 'destructive' : 'secondary'}
      className={
        status === 'completed' ? 'bg-primary/10 text-primary' : undefined
      }
    >
      {t(`status.${status}`)}
    </Badge>
  );
}

function StepRow({
  label,
  status,
  reason,
}: {
  label: string;
  status: 'success' | 'failed' | 'skipped' | 'processing' | 'queued';
  reason?: string;
}) {
  return (
    <li className="flex items-start gap-3 text-xs">
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
          status === 'success'
            ? 'bg-primary/10 text-primary'
            : status === 'failed'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-muted text-muted-foreground'
        )}
        aria-hidden
      >
        {status === 'success' ? (
          <Check className="h-3 w-3" />
        ) : status === 'failed' ? (
          <X className="h-3 w-3" />
        ) : status === 'processing' ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : status === 'queued' ? (
          <Clock className="h-3 w-3" />
        ) : (
          <Minus className="h-3 w-3" />
        )}
      </span>
      <div className="min-w-0 pt-0.5">
        <p
          className={
            status === 'skipped' ? 'text-muted-foreground' : 'text-foreground'
          }
        >
          {label}
        </p>
        {reason && <p className="text-destructive mt-1">{reason}</p>}
      </div>
    </li>
  );
}
