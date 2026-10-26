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
    .mockImplementation(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            JSON.parse(String(init?.body)).action === 'start'
              ? { session_id: 'session' }
              : { success: true }
          )
        )
    );
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
const apiCalls = () =>
  fetcher.mock.calls.filter(
    (call) => JSON.parse(String(call[1]?.body ?? '{}')).action !== 'abandon'
  );
async function click(text: string) {
  await act(async () => {
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === text)
      ?.click();
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
    expect(apiCalls()).toHaveLength(3);
    expect(changed).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('WhatsApp connected');
    expect(login.mock.calls[0]).toHaveLength(2);
  }
);
it('handles cancellation without exchanging a code', async () => {
  await launch();
  await event('CANCEL');
  expect(host.textContent).toContain('Signup cancelled');
  expect(apiCalls()).toHaveLength(1);
  expect(changed).not.toHaveBeenCalled();
});
it('handles incomplete Facebook authorization', async () => {
  await launch();
  await act(async () => callback({}));
  expect(host.textContent).toContain('cancelled or incomplete');
  expect(apiCalls()).toHaveLength(1);
});
it('keeps a failed setup open with a fresh-start message', async () => {
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
  expect(apiCalls()).toHaveLength(1);
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
it('requires a fresh Facebook setup after failure and never offers recovery', async () => {
  fetcher.mockImplementation(
    async (_url, init) =>
      new Response(
        JSON.stringify(
          JSON.parse(String(init?.body)).action === 'start'
            ? { session_id: 'fresh-session' }
            : { error: 'Connection failed' }
        ),
        {
          status: JSON.parse(String(init?.body)).action === 'start' ? 200 : 503,
        }
      )
  );
  await launch();
  await event();
  await act(async () => callback({ authResponse: { code: 'code' } }));
  expect(host.textContent).not.toMatch(/Recover saved|Discard saved/);
  await click('Connect WhatsApp');
  await click('Continue with Facebook');
  expect(login).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.some(
      (call) => JSON.parse(String(call[1]?.body)).action === 'recover'
    )
  ).toBe(false);
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
  expect(apiCalls()).toHaveLength(2);
  expect(changed).not.toHaveBeenCalled();
});

it('automatically clears cancelled setup without showing saved, recover or discard controls', async () => {
  await launch();
  await click('Cancel signup');
  expect(
    fetcher.mock.calls.some(
      (call) => JSON.parse(call[1]!.body as string).action === 'abandon'
    )
  ).toBe(true);
  expect(host.textContent).not.toMatch(
    /Saved setup|Recover saved|Discard saved/
  );
});
it('clears a prepared setup on unmount so a later visit starts from scratch', async () => {
  await act(() => root.render(<div />));
  expect(
    fetcher.mock.calls.some(
      (call) => JSON.parse(call[1]!.body as string).action === 'abandon'
    )
  ).toBe(true);
});

it('uses Meta’s current standard v4 launch options and retries a silent launch without another session', async () => {
  await act(() =>
    host.querySelector<HTMLInputElement>('input[value=cloud_api]')!.click()
  );
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
  expect(apiCalls()).toHaveLength(2);
  expect(login).toHaveBeenCalledTimes(2);
  await event();
  await act(() => earlier({ authResponse: { code: 'stale-code' } }));
  expect(apiCalls()).toHaveLength(2);
  await act(() => callback({ authResponse: { code: 'current-code' } }));
  expect(apiCalls()).toHaveLength(4);
  expect(host.textContent).toContain('WhatsApp connected');
});

it('calls FB.login before the actual click handler returns without any intervening request', async () => {
  await click('Connect WhatsApp');
  expect(apiCalls()).toHaveLength(1);
  expect(login).not.toHaveBeenCalled();
  let returned = false;
  login.mockImplementationOnce((cb) => {
    expect(returned).toBe(false);
    expect(apiCalls()).toHaveLength(1);
    callback = cb;
  });
  await act(() => {
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Continue with Facebook')
      ?.click();
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
    expect(apiCalls()).toHaveLength(1);
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
it('cancelling clears the launch watchdog and abandons the temporary session', async () => {
  vi.useFakeTimers();
  await launch();
  await click('Cancel signup');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(host.textContent).toContain('Signup cancelled');
  expect(host.textContent).not.toContain('Facebook has not confirmed');
  expect(apiCalls()).toHaveLength(1);
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
  expect(host.textContent).toContain('Connect a new WhatsApp number');
  expect(host.textContent).toContain('Connect my WhatsApp Business App');
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

it('exchanges the short-lived code before waiting for phone selection and ignores repeated SDK callbacks', async () => {
  await launch();
  await act(() => callback({ authResponse: { code: 'short-lived' } }));
  expect(JSON.parse(String(apiCalls()[1][1]?.body))).toEqual({
    action: 'authorize',
    session_id: 'session',
    code: 'short-lived',
  });
  expect(changed).not.toHaveBeenCalled();
  await act(() => callback({ authResponse: { code: 'short-lived' } }));
  expect(apiCalls()).toHaveLength(2);
  await event();
  expect(apiCalls()).toHaveLength(3);
});
it.each(['FINISH_OBO_MIGRATION', 'FINISH_GRANT_ONLY_API_ACCESS'])(
  'classifies %s without an endless authorization wait',
  async (kind) => {
    await launch();
    await event(kind);
    expect(host.textContent).toContain('Review activation with support');
    expect(host.textContent).toContain('keep your current provider connected');
  }
);
