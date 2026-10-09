// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WhatsAppEmbeddedSignup } from './whatsapp-embedded-signup';
import { signupDiagnostic } from '@/lib/whatsapp/embedded-signup-diagnostics';
let root: Root, host: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>(),
  changed = vi.fn();
let callback: (
  response?: {
    authResponse?: { code?: string };
    status?: string;
    error?: { code?: number; message?: string };
  } | null
) => void;
const login = vi.fn<(cb: typeof callback, options: object) => void>((cb) => {
  callback = cb;
});
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  window.FB = { init: vi.fn(), login };
  changed.mockResolvedValue(null);
  fetcher
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ session_id: 'session' }))
    )
    .mockResolvedValue(new Response(JSON.stringify({ success: true })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<WhatsAppEmbeddedSignup onChanged={changed} />));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await act(() => root.unmount());
  host.remove();
});
async function click(text: string) {
  await act(async () => {
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === text)!
      .click();
  });
}
async function event(event = 'FINISH') {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.facebook.com',
        data: {
          type: 'WA_EMBEDDED_SIGNUP',
          event,
          data: { waba_id: '123', phone_number_id: '456' },
        },
      })
    );
  });
}
async function launch() {
  await click('Connect WhatsApp');
  await click('Continue with Facebook');
}
it.each([true, false])(
  'pairs both callback orders exactly once and refreshes shared state, code first=%s',
  async (codeFirst) => {
    await launch();
    const code = async () => {
      await act(async () =>
        callback({ authResponse: { code: 'private-code' } })
      );
    };
    if (codeFirst) {
      await code();
      await event();
    } else {
      await event();
      await code();
    }
    await event();
    await code();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('WhatsApp connected');
    expect(login.mock.calls[0]).toHaveLength(2);
  }
);
it('handles cancellation without exchanging a code', async () => {
  await launch();
  await event('CANCEL');
  expect(host.textContent).toContain('Signup cancelled');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
});
it('handles incomplete Facebook authorization', async () => {
  await launch();
  await act(async () => callback({}));
  expect(host.textContent).toContain('cancelled or incomplete');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('refreshes recovery state after backend failure', async () => {
  fetcher
    .mockReset()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ session_id: 'session' }))
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'Subscription failed. Reconnect.' }),
        { status: 502 }
      )
    );
  await launch();
  await event();
  await act(async () => callback({ authResponse: { code: 'code' } }));
  expect(changed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Subscription failed');
});
it('handles Meta signup errors', async () => {
  await launch();
  await event('ERROR');
  expect(host.textContent).toContain('Meta reported a signup error');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('keeps interactive signup open beyond two minutes and completes normally', async () => {
  vi.useFakeTimers();
  await launch();
  await act(() => vi.advanceTimersByTime(5 * 60_000));
  expect(host.textContent).toContain('Check Facebook popup');
  expect(host.textContent).not.toContain('Waiting for Facebook');
  expect(host.textContent).not.toContain('timed out');
  vi.useRealTimers();
  await event();
  await act(async () => callback({ authResponse: { code: 'late-code' } }));
  expect(changed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('WhatsApp connected');
});
it('recovers a saved setup without opening Facebook again', async () => {
  fetcher
    .mockReset()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ session_id: 'session' }))
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Finalization failed' }), {
        status: 503,
      })
    )
    .mockResolvedValue(new Response(JSON.stringify({ success: true })));
  await launch();
  await event();
  await act(async () => callback({ authResponse: { code: 'code' } }));
  await click('Recover saved setup');
  expect(JSON.parse(fetcher.mock.calls[2][1]!.body as string)).toEqual({
    action: 'recover',
    session_id: 'session',
  });
  expect(login).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('setup recovered');
});
it('ignores authorization callbacks from a cancelled earlier launch', async () => {
  await launch();
  const earlier = callback;
  await click('Cancel signup');
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ session_id: 'new-session' }))
  );
  await launch();
  await event();
  await act(async () => earlier({ authResponse: { code: 'stale-code' } }));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(changed).not.toHaveBeenCalled();
});

const saved = {
  id: 'durable-session',
  connection_id: null,
  reconnect_id: null,
  context: { waba_id: '123', phone_number_id: '456' },
  created_at: '2026-10-08T00:00:00Z',
  recoverable: true,
  busy: false,
};
it('shows recovery after remount with a discovered connectionless attempt', async () => {
  fetcher
    .mockReset()
    .mockImplementation(
      async () => new Response(JSON.stringify({ success: true }))
    );
  await act(() =>
    root.render(
      <WhatsAppEmbeddedSignup
        key="refreshed-browser"
        attempts={[saved]}
        onChanged={changed}
      />
    )
  );
  await click('Recover saved setup');
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
    action: 'recover',
    session_id: saved.id,
  });
  expect(login).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
});
it('does not offer recovery merely because a connection exists', async () => {
  await act(() =>
    root.render(
      <WhatsAppEmbeddedSignup
        reconnectId="working-number"
        onChanged={changed}
      />
    )
  );
  expect(host.textContent).not.toContain('Recover saved setup');
});
it('explicit discard requires confirmation and sends only the attempt ID', async () => {
  fetcher
    .mockReset()
    .mockImplementation(
      async () => new Response(JSON.stringify({ success: true }))
    );
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(() =>
    root.render(
      <WhatsAppEmbeddedSignup attempts={[saved]} onChanged={changed} />
    )
  );
  await click('Discard saved setup');
  expect(fetcher).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await click('Discard saved setup');
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
    action: 'discard',
    session_id: saved.id,
  });
  expect(host.textContent).toContain('connections are unchanged');
  expect(changed).toHaveBeenCalledOnce();
  confirm.mockRestore();
});
it('Cancel signup leaves durable attempts available and never discards them', async () => {
  await act(() =>
    root.render(
      <WhatsAppEmbeddedSignup attempts={[saved]} onChanged={changed} />
    )
  );
  await launch();
  await click('Cancel signup');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Recover saved setup');
  expect(host.textContent).toContain('Discard saved setup');
});
it('disables recovery and discard while another worker holds the attempt lease', async () => {
  await act(() =>
    root.render(
      <WhatsAppEmbeddedSignup
        attempts={[{ ...saved, busy: true }]}
        onChanged={changed}
      />
    )
  );
  const actions = [...host.querySelectorAll('button')].filter((b) =>
    /Recover|Discard/.test(b.textContent!)
  );
  expect(actions).toHaveLength(2);
  expect(actions.every((b) => b.disabled)).toBe(true);
});

it('uses Meta’s current standard v4 launch options and retries a silent launch without another session', async () => {
  await launch();
  expect(login.mock.calls[0][1]).toEqual({
    config_id: '1445638484111991',
    response_type: 'code',
    override_default_response_type: true,
    extras: { setup: {} },
  });
  const earlier = callback;
  await click('Popup didn’t open?');
  expect(host.textContent).toContain('Allow popups for this site');
  await click('Continue with Facebook');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(login).toHaveBeenCalledTimes(2);
  await event();
  await act(() => earlier({ authResponse: { code: 'stale-code' } }));
  expect(fetcher).toHaveBeenCalledOnce();
  await act(() => callback({ authResponse: { code: 'current-code' } }));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('WhatsApp connected');
});

it('calls FB.login before the actual click handler returns without any intervening request', async () => {
  await click('Connect WhatsApp');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(login).not.toHaveBeenCalled();
  let returned = false;
  login.mockImplementationOnce((cb) => {
    expect(returned).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    callback = cb;
  });
  await act(() => {
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Continue with Facebook')!
      .click();
    expect(login).toHaveBeenCalledOnce();
    returned = true;
  });
});
it('replaces a silent launch spinner without cancelling late completion', async () => {
  vi.useFakeTimers();
  await launch();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(host.textContent).not.toContain('Waiting for Facebook');
  expect(host.textContent).toContain('Facebook has not confirmed the launch');
  expect(host.querySelector('.animate-spin')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  });
  await event();
  await act(() => callback({ authResponse: { code: 'late-secret-code' } }));
  expect(host.textContent).toContain('WhatsApp connected');
});
it('handles synchronous SDK login exceptions without logging error contents', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
  login.mockImplementationOnce(() => {
    throw new Error('private-oauth-secret');
  });
  await launch();
  expect(host.textContent).toContain('Facebook popup could not open');
  expect(host.textContent).not.toContain('Waiting for Facebook');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-oauth-secret');
  expect(log.mock.calls.some((c) => c[1] === 'fb_login_exception')).toBe(true);
});
it.each([undefined, null, { error: { code: 190, message: 'private-token' } }])(
  'handles empty or error callbacks without a stuck spinner: %j',
  async (response) => {
    await launch();
    await act(() => callback(response));
    expect(host.textContent).not.toContain('Waiting for Facebook');
    expect(host.textContent).not.toContain('private-token');
    expect(fetcher).toHaveBeenCalledOnce();
  }
);
it('logs only safe development milestones, not SDK payloads, OAuth codes or tokens', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
  await launch();
  await event();
  await act(() =>
    callback({
      status: 'connected',
      authResponse: { code: 'private-oauth-code' },
    })
  );
  const entries = log.mock.calls.map((c) => c[1]);
  expect(entries).toContain('fb_login_invoked');
  expect(entries).toContain('fb_login_callback');
  expect(entries).toContain('wa_embedded_signup_event');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-oauth-code');
  expect(JSON.stringify(log.mock.calls)).not.toContain('authResponse');
});
it('emits no diagnostic logs in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
  signupDiagnostic('fb_login_invoked', { hasCode: false });
  signupDiagnostic('signup_cancelled_or_error', { event: 'CANCEL' });
  expect(log).not.toHaveBeenCalled();
});
it('cancelling clears the launch watchdog and preserves the durable session', async () => {
  vi.useFakeTimers();
  await launch();
  await click('Cancel signup');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(host.textContent).toContain('Signup cancelled');
  expect(host.textContent).not.toContain('Facebook has not confirmed');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('reports enforced CSP directives in development without logging blocked URLs', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
  await act(() =>
    root.render(
      <WhatsAppEmbeddedSignup key="diagnostics" onChanged={changed} />
    )
  );
  const violation = Object.assign(new Event('securitypolicyviolation'), {
    effectiveDirective: 'script-src-elem',
    disposition: 'enforce',
    blockedURI: 'https://example.test/oauth?code=private-code',
  });
  await act(() => window.dispatchEvent(violation));
  expect(log).toHaveBeenCalledWith(
    '[WhatsApp Embedded Signup]',
    'csp_violation',
    { directive: 'script-src-elem', enforced: true }
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-code');
  expect(JSON.stringify(log.mock.calls)).not.toContain('blockedURI');
});

it('launches Coexistence and accepts WABA-only session completion', async () => {
  await act(() =>
    host.querySelector<HTMLInputElement>('input[value="coexistence"]')!.click()
  );
  await click('Connect WhatsApp');
  await click('Continue with Facebook');
  expect(login.mock.calls.at(-1)?.[1]).toMatchObject({
    extras: {
      featureType: 'whatsapp_business_app_onboarding',
      sessionInfoVersion: '3',
    },
  });
  await act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.facebook.com',
        data: {
          type: 'WA_EMBEDDED_SIGNUP',
          event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
          data: { waba_id: '123' },
          version: 3,
        },
      })
    )
  );
  await act(async () => callback({ authResponse: { code: 'code' } }));
  const saved = JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string);
  expect(saved).toMatchObject({
    completion_event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    context: { waba_id: '123' },
  });
});
