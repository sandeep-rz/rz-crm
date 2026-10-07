'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAutomationWhatsAppConnections } from '@/hooks/use-automation-whatsapp-connections';

import {
  AutomationBuilder,
  builderInitialFromApiPayload,
  type BuilderInitial,
} from '@/components/automations/automation-builder';

export default function EditAutomationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const connections = useAutomationWhatsAppConnections();
  const router = useRouter();
  const t = useTranslations('Automations.edit');
  const [initial, setInitial] = useState<BuilderInitial | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch(`/api/automations/${id}`);
      if (!res.ok) {
        if (!cancelled) setError(t('loadError', { status: res.status }));
        return;
      }
      const body = await res.json();
      if (cancelled) return;
      setInitial(builderInitialFromApiPayload(body));
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={() => router.push('/automations')}
          className="text-primary hover:text-primary/80 text-sm"
        >
          {t('back')}
        </button>
      </div>
    );
  }

  if (!initial || connections === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return <AutomationBuilder initial={initial} connections={connections} />;
}
