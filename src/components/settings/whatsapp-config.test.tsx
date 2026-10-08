// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WhatsAppConfig } from './whatsapp-config';
const h = vi.hoisted(() => ({
  connections: [] as Record<string, unknown>[],
  invalidate: vi.fn(),
  refresh: vi.fn(),
  wizard: {} as Record<string, unknown>,
  cards: [] as Record<string, unknown>[],
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: { id: 'user' },
    accountId: 'a',
    loading: false,
    profileLoading: false,
    canEditSettings: true,
  }),
}));
vi.mock('@/hooks/use-whatsapp-capability', () => ({
  useWhatsAppCapability: () => ({
    connections: h.connections,
    loading: false,
    status: 'available',
    error: null,
    invalidate: h.invalidate,
    refresh: h.refresh,
  }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./whatsapp-setup-ui', () => ({
  WhatsAppConnectionCard: (props: Record<string, unknown>) => {
    h.cards.push(props);
    return <button onClick={props.onManage as () => void}>Manage</button>;
  },
  WhatsAppEmptyState: ({ onConnect }: { onConnect: () => void }) => (
    <button onClick={onConnect}>Connect</button>
  ),
  AddWhatsAppConnectionButton: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Add</button>
  ),
  WhatsAppSetupWizard: (props: Record<string, unknown>) => {
    h.wizard = props;
    return null;
  },
  WhatsAppSetupGuide: () => null,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
let root: Root, host: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
const row = (id = 'number-a', is_primary = true) => ({
  id,
  display_name: id,
  is_primary,
  status: 'connected',
  phone_number_id: '123',
  waba_id: '456',
  registered_at: '2026-10-01T00:00:00Z',
  has_verify_token: true,
});
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  h.connections = [row()];
  h.cards = [];
  vi.clearAllMocks();
  fetcher.mockReset();
  h.invalidate.mockImplementation(async () => ({
    account_id: 'a',
    connections: h.connections,
  }));
  h.refresh.mockResolvedValue({ account_id: 'a', connections: h.connections });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    input === '/api/whatsapp/embedded-signup' && !init?.method
      ? Promise.resolve(
          new Response(JSON.stringify({ account_id: 'a', attempts: [] }))
        )
      : fetcher(input, init)
  );
  vi.stubGlobal('confirm', () => true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text)
  );
  expect(button, text).toBeTruthy();
  await act(() => button!.click());
};
it('opening settings or managing a connection does not fetch or claim live health', async () => {
  await act(() => root.render(<WhatsAppConfig />));
  expect(fetcher).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
  await act(async () => {
    await (h.cards.at(-1)!.onManage as () => Promise<void>)();
  });
  expect(host.textContent).toContain('Live Meta status not checked');
  expect(host.textContent).toContain('Registration last recorded');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([true, false])(
  'setup invalidates only after successful save, success=%s',
  async (success) => {
    h.connections = [];
    await act(() => root.render(<WhatsAppConfig />));
    await click('Advanced: manual connection');
    await act(() => {
      (h.wizard.setPhoneNumberId as (v: string) => void)('123');
      (h.wizard.setWabaId as (v: string) => void)('456');
      (h.wizard.setAccessToken as (v: string) => void)('private-entered-token');
      (h.wizard.onTokenEdited as () => void)();
    });
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify(
          success
            ? { success: true, registration_skipped: true }
            : { error: 'Rejected' }
        ),
        { status: success ? 200 : 400 }
      )
    );
    await act(async () => {
      await (h.wizard.onConnect as () => Promise<void>)();
    });
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
    expect(h.invalidate).toHaveBeenCalledTimes(success ? 1 : 0);
  }
);
it.each([true, false])(
  'make-primary invalidates only on success=%s',
  async (success) => {
    h.connections = [row(), row('number-b', false)];
    await act(() => root.render(<WhatsAppConfig />));
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify(success ? { success: true } : { error: 'Rejected' }),
        { status: success ? 200 : 400 }
      )
    );
    await act(async () => {
      await (h.cards.at(-1)!.onSetPrimary as () => Promise<void>)();
    });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      id: 'number-b',
      action: 'set_primary',
    });
    expect(h.invalidate).toHaveBeenCalledTimes(success ? 1 : 0);
  }
);
it.each([true, false])(
  'delete invalidates only on success=%s',
  async (success) => {
    await act(() => root.render(<WhatsAppConfig />));
    await act(async () => {
      await (h.cards.at(-1)!.onManage as () => Promise<void>)();
    });
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify(success ? { success: true } : { error: 'Rejected' }),
        { status: success ? 200 : 400 }
      )
    );
    await click('Delete connection');
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE');
    expect(h.invalidate).toHaveBeenCalledTimes(success ? 1 : 0);
  }
);
it('explicit testing uses the live endpoint and does not rewrite local connection health', async () => {
  await act(() => root.render(<WhatsAppConfig />));
  await act(async () => {
    await (h.cards.at(-1)!.onManage as () => Promise<void>)();
  });
  await click('Advanced settings');
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({
        verified: false,
        live: false,
        message: 'Meta temporarily unavailable',
      })
    )
  );
  await click('testConnection');
  expect(fetcher.mock.calls[0][0]).toBe(
    '/api/whatsapp/config/verify-registration?id=number-a'
  );
  expect(h.connections[0].status).toBe('connected');
  expect(h.invalidate).not.toHaveBeenCalled();
});
it('changing inbound media retention invalidates local configuration', async () => {
  await act(() => root.render(<WhatsAppConfig />));
  await act(async () => {
    await (h.cards.at(-1)!.onManage as () => Promise<void>)();
  });
  await click('Advanced settings');
  fetcher.mockResolvedValue(new Response(JSON.stringify({ success: true })));
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(toggle).toBeTruthy();
  await act(() => toggle!.click());
  expect(fetcher.mock.calls[0][1]?.method).toBe('PATCH');
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
    id: 'number-a',
    mirror_inbound_media: false,
  });
  expect(h.invalidate).toHaveBeenCalledOnce();
});
