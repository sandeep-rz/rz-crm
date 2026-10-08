'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ActivityRetryState } from '@/lib/automations/manual-retry';

export function ExecutionRetry({
  logId,
  state,
  onQueued,
}: {
  logId: string;
  state?: ActivityRetryState;
  onQueued: () => void;
}) {
  const t = useTranslations('Automations.logs');
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const inFlight = useRef(false);
  if (queued || state === 'already_retried')
    return (
      <span className="text-muted-foreground px-3 text-xs" role="status">
        {t('retryQueued')}
      </span>
    );
  if (state !== 'eligible' || unavailable) return null;
  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const response = await fetch(
        `/api/automations/executions/${logId}/retry`,
        { method: 'POST' }
      );
      const body = await response.json();
      if (!response.ok) {
        const key =
          body.code === 'unsafe_to_retry'
            ? 'retryUnsafe'
            : body.code === 'already_completed'
              ? 'retryCompleted'
              : body.code === 'already_retried'
                ? 'retryAlreadyQueued'
                : body.code === 'retry_unavailable'
                  ? 'retryError'
                  : 'retryIneligible';
        toast.error(t(key));
        if (
          body.code !== 'already_retried' &&
          body.code !== 'retry_unavailable'
        )
          setUnavailable(true);
        if (body.code === 'already_retried') {
          setQueued(true);
          onQueued();
        }
        return;
      }
      setQueued(true);
      toast.success(t('retrySuccess'));
      onQueued();
    } catch {
      toast.error(t('retryError'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={retry}>
      {pending ? t('retrying') : t('retry')}
    </Button>
  );
}
