'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  signupEvent,
  embeddedSignupConfig,
  type SignupContext,
  type SavedSignupAttempt,
} from '@/lib/whatsapp/embedded-signup-context';

type Facebook = {
  init: (options: object) => void;
  login: (
    callback: (response: {
      authResponse?: { code?: string };
      status?: string;
    }) => void,
    options: object
  ) => void;
};
declare global {
  interface Window {
    FB?: Facebook;
  }
}
let sdk: Promise<Facebook> | undefined;
function loadSdk() {
  if (sdk) return sdk;
  sdk = new Promise<Facebook>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error('Facebook SDK timed out. Reload the page and retry.')),
      15_000
    );
    const loaded = () => {
      clearTimeout(timeout);
      if (!window.FB) return reject(new Error('Facebook SDK unavailable.'));
      window.FB.init({
        appId: embeddedSignupConfig.appId,
        version: embeddedSignupConfig.sdkVersion,
        autoLogAppEvents: false,
        xfbml: false,
      });
      resolve(window.FB);
    };
    if (window.FB) return loaded();
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.onload = loaded;
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      reject(
        new Error('Facebook could not load. Check browser blockers and retry.')
      );
    };
    document.head.appendChild(script);
  }).catch((error) => {
    sdk = undefined;
    throw error;
  });
  return sdk;
}
async function api(body: object) {
  const response = await fetch('/api/whatsapp/embedded-signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'WhatsApp setup failed.');
  return data;
}

export function WhatsAppEmbeddedSignup({
  reconnectId,
  attempts = [],
  onChanged,
}: {
  reconnectId?: string;
  attempts?: SavedSignupAttempt[];
  onChanged: () => Promise<unknown>;
}) {
  const [phase, setPhase] = useState<
    'idle' | 'preparing' | 'ready' | 'signup' | 'saving'
  >('idle');
  const [message, setMessage] = useState('');
  const prepared = useRef<{ session: string; fb: Facebook } | null>(null);
  const run = useRef<{
    code?: string;
    context?: SignupContext;
    submitted: boolean;
  } | null>(null);
  const [recoverySession, setRecoverySession] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      run.current = null;
    };
  }, []);
  const stop = (text: string) => {
    run.current = null;
    prepared.current = null;
    setMessage(text);
    setPhase('idle');
  };
  const complete = async () => {
    const current = run.current;
    if (
      !current ||
      current.submitted ||
      !current.code ||
      !current.context ||
      !prepared.current
    )
      return;
    current.submitted = true;
    setPhase('saving');
    setRecoverySession(prepared.current.session);
    try {
      await api({
        action: 'complete',
        session_id: prepared.current.session,
        code: current.code,
        context: current.context,
      });
      if (alive.current) {
        setRecoverySession(null);
        stop(
          'WhatsApp connected. Payment setup still needs to be checked in WhatsApp Manager.'
        );
      }
    } catch (error) {
      if (alive.current)
        stop(
          error instanceof Error
            ? error.message
            : 'Connection failed. Retry signup.'
        );
    } finally {
      if (alive.current) await onChanged();
    }
  };
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!run.current || run.current.submitted) return;
      const result = signupEvent(event.origin, event.data);
      if (!result) return;
      if (result.event === 'FINISH') {
        run.current.context = result.context;
        void complete();
      } else
        stop(
          result.event === 'CANCEL'
            ? 'Signup cancelled. You can try again.'
            : result.event === 'INCOMPLETE'
              ? 'Signup did not return both a WhatsApp account and number. Start again.'
              : 'Meta reported a signup error. Start again.'
        );
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  });
  async function prepare() {
    setPhase('preparing');
    setMessage('');
    try {
      const fb = await loadSdk();
      const data = await api({
        action: 'start',
        ...(reconnectId ? { reconnect_id: reconnectId } : {}),
      });
      if (alive.current) {
        prepared.current = { fb, session: data.session_id };
        setPhase('ready');
      }
    } catch (error) {
      if (alive.current)
        stop(
          error instanceof Error ? error.message : 'Could not start signup.'
        );
    }
  }
  async function recover(session = recoverySession) {
    setPhase('saving');
    setMessage('Checking saved credentials and current Meta state…');
    try {
      await api({
        action: 'recover',
        ...(session ? { session_id: session } : { connection_id: reconnectId }),
      });
      if (alive.current) {
        setRecoverySession(null);
        stop(
          'WhatsApp setup recovered. Check payment readiness in WhatsApp Manager.'
        );
      }
    } catch (error) {
      if (alive.current)
        stop(
          error instanceof Error
            ? error.message
            : 'Recovery failed. Retry saved setup.'
        );
    } finally {
      if (alive.current) await onChanged();
    }
  }
  async function discard(session: string) {
    if (
      !window.confirm(
        'Discard this saved setup? Your working WhatsApp connection will stay unchanged. This does not undo changes already made in Meta.'
      )
    )
      return;
    setPhase('saving');
    try {
      await api({ action: 'discard', session_id: session });
      if (alive.current) {
        if (recoverySession === session) setRecoverySession(null);
        stop('Saved setup discarded. Your WhatsApp connections are unchanged.');
      }
    } catch (error) {
      if (alive.current)
        stop(
          error instanceof Error
            ? error.message
            : 'Could not discard saved setup.'
        );
    } finally {
      if (alive.current) await onChanged();
    }
  }
  const visibleAttempts = attempts.filter(
    (a) =>
      !reconnectId ||
      a.connection_id === reconnectId ||
      a.reconnect_id === reconnectId
  );
  function launch() {
    if (!prepared.current) return;
    setPhase('signup');
    setMessage(
      'Complete signup in the Facebook popup. You can take your time or cancel here. If it does not open, allow popups and retry.'
    );
    const current = { submitted: false };
    run.current = current;
    try {
      // Must run synchronously from the click to retain browser popup permission.
      prepared.current.fb.login(
        (response) => {
          if (run.current !== current || current.submitted) return;
          if (!response.authResponse?.code) {
            stop(
              'Facebook authorization was cancelled or incomplete. Start again.'
            );
            return;
          }
          run.current.code = response.authResponse.code;
          void complete();
        },
        {
          config_id: embeddedSignupConfig.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { sessionInfoVersion: 3 },
        }
      );
    } catch {
      stop('Facebook popup could not open. Allow popups and retry.');
    }
  }
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="font-medium">
        {reconnectId ? 'Reconnect WhatsApp' : 'Connect WhatsApp'}
      </p>
      <p className="text-muted-foreground text-sm">
        Connect your WhatsApp Business account securely with Facebook.
        {reconnectId
          ? ' This explicitly replaces credentials for this same number.'
          : ''}
      </p>
      <Button
        disabled={['preparing', 'signup', 'saving'].includes(phase)}
        onClick={phase === 'ready' ? launch : () => void prepare()}
      >
        {phase === 'ready'
          ? 'Continue with Facebook'
          : phase === 'preparing'
            ? 'Preparing…'
            : phase === 'signup'
              ? 'Waiting for Facebook…'
              : phase === 'saving'
                ? 'Connecting…'
                : reconnectId
                  ? 'Reconnect WhatsApp'
                  : 'Connect WhatsApp'}
      </Button>
      {phase === 'signup' && (
        <Button
          variant="outline"
          onClick={() => stop('Signup cancelled. You can try again.')}
        >
          Cancel signup
        </Button>
      )}
      {recoverySession &&
        !visibleAttempts.some((a) => a.id === recoverySession) &&
        phase === 'idle' && (
          <Button variant="outline" onClick={() => void recover()}>
            Recover saved setup
          </Button>
        )}
      {phase === 'idle' &&
        visibleAttempts.map((attempt) => (
          <div key={attempt.id} className="space-y-2 rounded border p-3">
            <p className="text-sm">
              Saved setup ·{' '}
              {attempt.context
                ? `Number ID ${attempt.context.phone_number_id}`
                : 'Facebook signup not completed'}{' '}
              · {new Date(attempt.created_at).toLocaleString()}
            </p>
            {!attempt.recoverable && !attempt.busy && (
              <p className="text-sm">
                Saved authorization is unavailable or expired. Discard this
                setup before starting again.
              </p>
            )}
            {attempt.busy && (
              <p className="text-sm">
                Setup is being processed. Wait three minutes after an
                interruption, then refresh.
              </p>
            )}
            {attempt.recoverable && (
              <Button
                variant="outline"
                disabled={attempt.busy}
                onClick={() => void recover(attempt.id)}
              >
                Recover saved setup
              </Button>
            )}
            <Button
              variant="outline"
              disabled={attempt.busy}
              onClick={() => void discard(attempt.id)}
            >
              Discard saved setup
            </Button>
          </div>
        ))}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <p className="text-muted-foreground text-sm">
        You pay Meta directly for WhatsApp usage. RGCRM SaaS charges are
        separate. Signup does not confirm payment readiness. In{' '}
        <a
          className="underline"
          href="https://business.facebook.com/wa/manage/home/"
          target="_blank"
          rel="noopener noreferrer"
        >
          WhatsApp Manager
        </a>
        , select this WhatsApp account and configure its payment method under
        Payment settings.
      </p>
    </div>
  );
}
