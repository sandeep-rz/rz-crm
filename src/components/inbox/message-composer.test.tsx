// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageComposer } from './message-composer';
const h = vi.hoisted(() => ({ fine: false, canSend: true, send: vi.fn() }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => h.canSend }));
vi.mock('@/hooks/use-whatsapp-capability', () => ({
  useWhatsAppCapability: () => ({ available: true, status: 'connected' }),
}));
vi.mock('@/components/ui/gated-button', () => ({
  GatedButton: ({
    canAct,
    gateReason: _reason,
    disabled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    canAct: boolean;
    gateReason?: string;
  }) => {
    void _reason;
    return <button {...props} disabled={!canAct || disabled} />;
  },
}));
vi.mock('./quick-reply-picker', () => ({ QuickReplyPicker: () => null }));
vi.mock('@/components/interactive/interactive-builder', () => ({
  InteractiveBuilder: () => null,
  blankButtonsPayload: () => ({ type: 'buttons', body: '', buttons: [] }),
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  h.fine = false;
  h.canSend = true;
  h.send.mockReset();
  vi.stubGlobal('matchMedia', () => ({
    matches: h.fine,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () =>
    root.render(
      <MessageComposer
        conversationId="c1"
        sessionExpired={false}
        onSend={h.send}
        onSendMedia={() => {}}
        onSendInteractive={() => {}}
        onOpenTemplates={() => {}}
      />
    )
  );
async function input() {
  const area = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )!.set!.call(area, 'Hello');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return area;
}
it('keeps Enter as a newline on a touch device', async () => {
  await render();
  const area = await input();
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    area.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(false);
  expect(h.send).not.toHaveBeenCalled();
});
it('sends on desktop Enter while preserving Shift+Enter', async () => {
  h.fine = true;
  await render();
  const area = await input();
  await act(async () => {
    area.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  expect(h.send).not.toHaveBeenCalled();
  await act(async () => {
    area.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
  });
  expect(h.send).toHaveBeenCalledWith('Hello', undefined);
});
it('does not send while an input method is composing text', async () => {
  h.fine = true;
  await render();
  const area = await input();
  await act(async () => {
    area.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  expect(h.send).not.toHaveBeenCalled();
});
it('retains the read-only composer restriction', async () => {
  h.canSend = false;
  await render();
  expect(host.querySelector('textarea')?.disabled).toBe(true);
});
