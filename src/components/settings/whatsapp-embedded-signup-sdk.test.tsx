// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WhatsAppEmbeddedSignup } from './whatsapp-embedded-signup';

it('recovers from SDK init errors and load timeout, then initializes once through fbAsyncInit', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ session_id: 'session' }))
    );
  vi.stubGlobal('fetch', fetcher);
  window.FB = {
    init: () => {
      throw new Error('SDK rejected initialization');
    },
    login: vi.fn(),
  };
  const click = async (text: string) => {
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((b) => b.textContent === text)!
        .click()
    );
  };
  try {
    await act(() =>
      root.render(<WhatsAppEmbeddedSignup onChanged={vi.fn()} />)
    );
    await click('Connect WhatsApp');
    expect(host.textContent).toContain('could not initialize');
    expect(fetcher).not.toHaveBeenCalled();
    delete window.FB;
    vi.useFakeTimers();
    await click('Connect WhatsApp');
    expect(
      document.querySelector('script[src*="connect.facebook.net"]')
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(host.textContent).toContain('Facebook SDK timed out');
    expect(
      document.querySelector('script[src*="connect.facebook.net"]')
    ).toBeNull();
    vi.useRealTimers();
    await click('Connect WhatsApp');
    const init = vi.fn(),
      login = vi.fn();
    window.FB = { init, login };
    const script = document.querySelector(
      'script[src*="connect.facebook.net"]'
    )!;
    await act(async () => {
      window.fbAsyncInit!();
      script.dispatchEvent(new Event('load'));
    });
    expect(init).toHaveBeenCalledExactlyOnceWith({
      appId: '1444327167651307',
      version: 'v26.0',
      autoLogAppEvents: false,
      xfbml: false,
    });
    expect(host.textContent).toContain('Continue with Facebook');
    expect(login).not.toHaveBeenCalled();
    await click('Continue with Facebook');
    expect(login).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    await act(() => root.unmount());
    host.remove();
    document
      .querySelectorAll('script[src*="connect.facebook.net"]')
      .forEach((s) => s.remove());
    delete window.FB;
    delete window.fbAsyncInit;
    vi.unstubAllGlobals();
  }
});
