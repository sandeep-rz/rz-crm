'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { ExecutionRetry } from '@/components/automations/execution-retry';
import type { RetryActivityLog } from '@/lib/automations/manual-retry';
import type {
  Automation,
  AutomationLog,
  AutomationLogStepResult,
} from '@/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/automations/trigger-meta';

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
  const tRelative = useTranslations('Automations.relative');

  const [automation, setAutomation] = useState<Automation | null>(null);
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
          log.manual_retry_state === 'already_retried' ||
          log.trigger_job_execution_state === 'processing'
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
            return (
              <li
                key={log.id}
                className="border-border bg-card rounded-xl border"
              >
                <div className="flex items-center gap-3 pr-4">
                  <button
                    type="button"
                    onClick={() => setOpenLogId(isOpen ? null : log.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="text-muted-foreground h-4 w-4" />
                    ) : (
                      <ChevronRight className="text-muted-foreground h-4 w-4" />
                    )}
                    <StatusBadge
                      status={
                        log.trigger_job_execution_state === 'processing'
                          ? 'processing'
                          : log.status
                      }
                      t={t}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm font-medium">
                        {log.contact?.name ??
                          log.contact?.phone ??
                          t('unknownContact')}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {log.trigger_job_attempt_count && (
                          <>
                            {t('attempt', {
                              count: log.trigger_job_attempt_count,
                            })}{' '}
                            ·{' '}
                          </>
                        )}
                        {log.trigger_event} · {log.steps_executed?.length ?? 0}{' '}
                        {log.steps_executed?.length === 1
                          ? t('step', { count: 1 }).replace('1 ', '')
                          : t('stepPlural', {
                              count: log.steps_executed?.length ?? 0,
                            }).replace(/^[0-9]+ /, '')}
                      </div>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {formatRelative(log.created_at, tRelative)}
                    </div>
                  </button>
                  <ExecutionRetry
                    logId={log.id}
                    state={log.manual_retry_state}
                    onQueued={() => {
                      setLogs(
                        (current) =>
                          current?.map((row) =>
                            row.id === log.id
                              ? {
                                  ...row,
                                  manual_retry_state: 'already_retried',
                                }
                              : row
                          ) ?? null
                      );
                      setRevision((value) => value + 1);
                    }}
                  />
                </div>
                {isOpen && (
                  <div className="border-border border-t px-4 py-3">
                    {log.error_message && (
                      <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                        {log.error_message}
                      </p>
                    )}
                    <ul className="space-y-1.5">
                      {(log.steps_executed ?? []).map((r, i) => (
                        <StepRow key={i} result={r} />
                      ))}
                      {(log.steps_executed ?? []).length === 0 && (
                        <li className="text-muted-foreground text-xs">
                          {t('noSteps')}
                        </li>
                      )}
                    </ul>
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
  status: AutomationLog['status'] | 'processing';
  t: ReturnType<typeof useTranslations>;
}) {
  const classes =
    status === 'success'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : status === 'partial' || status === 'processing'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : 'border-red-500/30 bg-red-500/10 text-red-300';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        classes
      )}
    >
      {t(`status.${status}`)}
    </span>
  );
}

function StepRow({ result }: { result: AutomationLogStepResult }) {
  const ok = result.status === 'success';
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full',
          ok ? 'bg-primary/20 text-primary' : 'bg-red-500/20 text-red-400'
        )}
        aria-hidden
      >
        {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </span>
      <span className="text-muted-foreground">{result.step_type}</span>
      {result.detail && (
        <span className="text-muted-foreground truncate">
          — {result.detail}
        </span>
      )}
    </li>
  );
}
