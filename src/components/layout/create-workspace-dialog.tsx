'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const MAX_WORKSPACE_NAME_LENGTH = 100;

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: CreateWorkspaceDialogProps) {
  const t = useTranslations('CreateWorkspace');
  const { createWorkspace, creatingWorkspace } = useAuth();
  const [name, setName] = useState('');

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && creatingWorkspace) return;
    if (!nextOpen) setName('');
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingWorkspace) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('nameRequired'));
      return;
    }
    if (trimmedName.length > MAX_WORKSPACE_NAME_LENGTH) {
      toast.error(t('nameTooLong', { max: MAX_WORKSPACE_NAME_LENGTH }));
      return;
    }

    try {
      await createWorkspace(trimmedName);
      onOpenChange(false);
      setName('');
      toast.success(t('success', { name: trimmedName }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('createFailed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            <Label htmlFor="workspace-name">{t('nameLabel')}</Label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('namePlaceholder')}
              maxLength={MAX_WORKSPACE_NAME_LENGTH}
              autoComplete="organization"
              autoFocus
              disabled={creatingWorkspace}
              className="border-border bg-muted"
            />
          </div>

          <DialogFooter className="border-border bg-popover">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={creatingWorkspace}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || creatingWorkspace}>
              {creatingWorkspace ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
