'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

export function DeleteConversationDialog({
  conversationId,
  accountId,
  onDeleted,
  disabled = false,
}: {
  conversationId: string;
  accountId: string;
  onDeleted: (id: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Inbox.deleteConversation');
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy || confirmation !== 'DELETE') return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, accountId }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || t('failed'));
        return;
      }
      setOpen(false);
      if (result.cleanupPending) {
        // The chat is already gone. Retain a concrete way to retry file cleanup.
        toast.warning(t('cleanupPending'), {
          duration: 15000,
          action: {
            label: t('retryCleanup'),
            onClick: () => {
              void fetch(`/api/conversations/${conversationId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: true, accountId }),
              })
                .then(async (response) => {
                  const result = await response.json();
                  if (!response.ok || result.cleanupPending)
                    toast.error(t('cleanupPending'));
                  else toast.success(t('deleted'));
                })
                .catch(() => toast.error(t('cleanupPending')));
            },
          },
        });
      } else toast.success(t('deleted'));
      onDeleted(conversationId);
    } catch {
      setError(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        disabled={disabled}
        variant="ghost"
        size="icon-sm"
        aria-label={t('title')}
        title={t('title')}
        onClick={() => {
          setConfirmation('');
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 className="text-destructive h-3.5 w-3.5" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
          <label className="grid gap-2">
            {t('confirmation')}
            <input
              className="border-input rounded-md border px-3 py-2"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </label>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy || confirmation !== 'DELETE'}
              onClick={() => {
                void remove();
              }}
            >
              {busy ? t('deleting') : t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
