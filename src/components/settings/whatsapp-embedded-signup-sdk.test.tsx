// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WhatsAppEmbeddedSignup } from './whatsapp-embedded-signup';

it('rejects init/load failures and never treats Meta’s bootstrap stub onload as ready', async () => {
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
    const bufferedInit = vi.fn(),
      bufferedLogin = vi.fn();
    window.FB = {
      __buffer: { calls: [], opts: null },
      init: bufferedInit,
      login: bufferedLogin,
    };
    const script = document.querySelector(
      'script[src*="connect.facebook.net"]'
    )!;
    await act(() => script.dispatchEvent(new Event('load')));
    expect(bufferedInit).not.toHaveBeenCalled();
    expect(bufferedLogin).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Continue with Facebook');
    const preparing = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Preparing…'
    )! as HTMLButtonElement;
    expect(preparing.disabled).toBe(true);
    await act(() => preparing.click());
    expect(fetcher).not.toHaveBeenCalled();
    // The full SDK replaces window.FB; preparation must capture this object,
    // never the stale stub whose queue has already been replayed by Meta.
    window.FB = { init, login };
    await act(async () => {
      window.fbAsyncInit!();
    });
    expect(init).toHaveBeenCalledExactlyOnceWith({
      appId: '1444327167651307',
      version: 'v26.0',
      autoLogAppEvents: false,
      xfbml: false,
      fedCM: false,
    });
    expect(host.textContent).toContain('Continue with Facebook');
    expect(login).not.toHaveBeenCalled();
    await click('Continue with Facebook');
    expect(login).toHaveBeenCalledOnce();
    expect(bufferedLogin).not.toHaveBeenCalled();
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
