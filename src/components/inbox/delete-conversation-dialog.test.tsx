// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DeleteConversationDialog } from './delete-conversation-dialog';
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  deleted: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: h.warning },
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
let host: HTMLDivElement, root: Root;
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  vi.stubGlobal('fetch', h.fetch);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <DeleteConversationDialog
        conversationId="chat"
        accountId="account"
        onDeleted={h.deleted}
      />
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
async function openAndConfirm() {
  await act(async () => host.querySelector('button')!.click());
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, 'DELETE');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('requires typed confirmation and sends the selected workspace', async () => {
  await act(async () => host.querySelector('button')!.click());
  expect(button('delete').disabled).toBe(true);
  await openAndConfirm();
  expect(button('delete').disabled).toBe(false);
  h.fetch.mockResolvedValue(
    new Response(JSON.stringify({ success: true, cleanupPending: false }))
  );
  await act(async () => button('delete').click());
  expect(h.fetch).toHaveBeenCalledWith(
    '/api/conversations/chat',
    expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ confirm: true, accountId: 'account' }),
    })
  );
  expect(h.deleted).toHaveBeenCalledWith('chat');
});
it('keeps the chat visible on a busy error', async () => {
  await openAndConfirm();
  h.fetch.mockResolvedValue(
    new Response(JSON.stringify({ error: 'Chat is processing a reply' }), {
      status: 409,
    })
  );
  await act(async () => button('delete').click());
  expect(h.deleted).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'processing'
  );
});
it('removes the deleted chat even when attachment cleanup needs retry', async () => {
  await openAndConfirm();
  h.fetch.mockResolvedValue(
    new Response(JSON.stringify({ success: true, cleanupPending: true }))
  );
  await act(async () => button('delete').click());
  expect(h.deleted).toHaveBeenCalledWith('chat');
  expect(h.warning).toHaveBeenCalledWith(
    'cleanupPending',
    expect.objectContaining({
      action: expect.objectContaining({ label: 'retryCleanup' }),
    })
  );
});
