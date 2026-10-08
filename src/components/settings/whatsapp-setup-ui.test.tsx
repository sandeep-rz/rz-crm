// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WhatsAppConnectionCard } from './whatsapp-setup-ui';
import type { WhatsAppConnectionSummary } from '@/lib/whatsapp/config-state';
it.each([
  ['disconnected', null, null, 'Setup incomplete'],
  ['connected', null, null, 'Setup incomplete'],
  [
    'connected',
    '2026-10-08',
    '2026-10-08',
    'Connected · verified during setup',
  ],
])(
  'distinguishes Embedded Signup state: %s %s %s',
  async (status, registered_at, subscribed_apps_at, label) => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    const connection = {
      id: 'connection',
      status,
      registered_at,
      subscribed_apps_at,
      onboarding_metadata: { method: 'embedded_signup' },
    } as WhatsAppConnectionSummary;
    await act(() =>
      root.render(
        <WhatsAppConnectionCard
          connection={connection}
          showPrimary={false}
          canManage
          onManage={vi.fn()}
          onSetPrimary={vi.fn()}
        />
      )
    );
    expect(host.textContent).toContain(label);
    await act(() => root.unmount());
  }
);
