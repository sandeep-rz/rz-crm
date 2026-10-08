// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WhatsAppEmbeddedSignup } from './whatsapp-embedded-signup';
let root: Root, host: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>(),
  changed = vi.fn();
let callback: (response: { authResponse?: { code?: string } }) => void;
const login = vi.fn((cb: typeof callback) => {
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
  await launch();
  vi.useFakeTimers();
  await act(() => vi.advanceTimersByTime(5 * 60_000));
  expect(host.textContent).toContain('Waiting for Facebook');
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
