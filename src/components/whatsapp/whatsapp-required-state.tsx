'use client';

import Link from 'next/link';
import { AlertCircle, Loader2, MessageSquareOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useWhatsAppCapability } from '@/hooks/use-whatsapp-capability';

export function WhatsAppCapabilityGate({
  children,
  feature,
}: {
  children: React.ReactNode;
  feature: string;
}) {
  const capability = useWhatsAppCapability();

  if (capability.status === 'loading') {
    return (
      <div className="flex h-64 items-center justify-center" aria-live="polite">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
        <span className="sr-only">Checking WhatsApp connection</span>
      </div>
    );
  }

  if (capability.status === 'error') {
    return (
      <div className="border-border bg-card flex min-h-64 flex-col items-center justify-center rounded-xl border p-6 text-center">
        <AlertCircle className="text-destructive mb-3 h-10 w-10" />
        <h2 className="text-foreground font-semibold">
          Could not verify WhatsApp availability
        </h2>
        <p className="text-muted-foreground mt-1 max-w-md text-sm">
          Nothing has been marked disconnected. Retry the capability check.
        </p>
        <Button className="mt-4" variant="outline" onClick={capability.refresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (!capability.available) {
    return (
      <div className="border-border bg-card flex min-h-64 flex-col items-center justify-center rounded-xl border p-6 text-center">
        <MessageSquareOff className="text-muted-foreground mb-3 h-10 w-10" />
        <h2 className="text-foreground font-semibold">
          Connect WhatsApp to use {feature}
        </h2>
        <p className="text-muted-foreground mt-1 max-w-md text-sm">
          This workspace needs at least one connected WhatsApp Business number.
        </p>
        <Button
          className="mt-4"
          render={<Link href="/settings?tab=whatsapp" />}
        >
          Set up WhatsApp
        </Button>
      </div>
    );
  }

  return children;
}
