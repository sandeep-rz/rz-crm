'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  ArrowRight,
  ExternalLink,
  Loader2,
  MessageCircle,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
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
    fbAsyncInit?: () => void;
  }
}
let sdk: Promise<Facebook> | undefined;
function loadSdk() {
  if (sdk) return sdk;
  sdk = new Promise<Facebook>((resolve, reject) => {
    let settled = false;
    const script = document.createElement('script');
    const previousInit = window.fbAsyncInit;
    const cleanup = () => {
      clearTimeout(timeout);
      if (window.fbAsyncInit === loaded) window.fbAsyncInit = previousInit;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      reject(error);
    };
    const loaded = () => {
      if (settled) return;
      try {
        if (!window.FB) throw new Error('Facebook SDK unavailable.');
        window.FB.init({
          appId: embeddedSignupConfig.appId,
          version: embeddedSignupConfig.sdkVersion,
          autoLogAppEvents: false,
          xfbml: false,
        });
        settled = true;
        cleanup();
        resolve(window.FB);
      } catch {
        fail(
          new Error(
            'Facebook SDK could not initialize. Reload the page and check browser blockers.'
          )
        );
      }
    };
    const timeout = setTimeout(
      () =>
        fail(new Error('Facebook SDK timed out. Reload the page and retry.')),
      15_000
    );
    if (window.FB) return loaded();
    // Meta's generated async loader initializes through this callback. onload
    // is a fallback for an SDK that was already loaded by the browser cache.
    window.fbAsyncInit = loaded;
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.onload = () => {
      if (window.FB) loaded();
    };
    script.onerror = () =>
      fail(
        new Error('Facebook could not load. Check browser blockers and retry.')
      );
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
  prominent = false,
  onManualSetup,
  onChanged,
}: {
  reconnectId?: string;
  attempts?: SavedSignupAttempt[];
  prominent?: boolean;
  onManualSetup?: () => void;
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
          // Match the launch selector generated for this exact Meta v4 config.
          extras: { version: 'v4', sessionInfoVersion: '3' },
        }
      );
    } catch {
      stop('Facebook popup could not open. Allow popups and retry.');
    }
  }
  return (
    <div
      className={cn(
        'bg-card text-card-foreground overflow-hidden rounded-2xl border shadow-sm',
        prominent && 'mx-auto max-w-2xl'
      )}
    >
      <div
        className={cn(
          'space-y-5 p-6 sm:p-8',
          prominent && 'flex flex-col items-center py-8 text-center sm:py-10'
        )}
      >
        <div
          className={cn(
            'flex items-start gap-4',
            prominent && 'flex-col items-center gap-5'
          )}
        >
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/15 dark:text-emerald-400">
            <MessageCircle aria-hidden="true" className="size-7" />
          </div>
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs font-semibold tracking-widest uppercase">
              WhatsApp Business
            </p>
            <h2 className="text-foreground text-2xl font-semibold tracking-tight">
              {reconnectId ? 'Reconnect WhatsApp' : 'Connect WhatsApp'}
            </h2>
            <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
              {reconnectId
                ? 'Securely refresh access to this number with Facebook.'
                : 'Bring customer conversations, replies and templates together in your shared inbox.'}
            </p>
          </div>
        </div>
        <div
          className={cn(
            'flex flex-wrap items-center gap-3',
            prominent && 'justify-center'
          )}
        >
          <Button
            className="h-12 gap-3 rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white shadow-md shadow-emerald-600/15 transition-all hover:bg-emerald-700 hover:shadow-lg hover:shadow-emerald-600/20 motion-safe:hover:-translate-y-0.5 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            disabled={['preparing', 'signup', 'saving'].includes(phase)}
            onClick={phase === 'ready' ? launch : () => void prepare()}
          >
            {['preparing', 'signup', 'saving'].includes(phase) ? (
              <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            ) : (
              <MessageCircle aria-hidden="true" className="size-5" />
            )}
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
            {!['preparing', 'signup', 'saving'].includes(phase) && (
              <ArrowRight aria-hidden="true" className="size-4" />
            )}
          </Button>
          {phase === 'signup' && (
            <Button
              variant="outline"
              onClick={() => stop('Signup cancelled. You can try again.')}
            >
              Cancel signup
            </Button>
          )}
          {phase === 'signup' && (
            <Button
              variant="outline"
              onClick={() => {
                // Invalidate this callback pair before retrying. Keep the durable
                // session; retry must be another direct click, without network work.
                run.current = null;
                setPhase('ready');
                setMessage(
                  'Allow popups for this site, then click Continue with Facebook. If it still does not open, check the browser console and the app’s allowed SDK domains in Meta. Close any earlier signup popup before retrying.'
                );
              }}
            >
              Popup didn’t open?
            </Button>
          )}
        </div>
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <ShieldCheck
            aria-hidden="true"
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
          Secure setup through Facebook · Your business stays in control
        </p>
        {recoverySession &&
          !visibleAttempts.some((a) => a.id === recoverySession) &&
          phase === 'idle' && (
            <Button variant="outline" onClick={() => void recover()}>
              Recover saved setup
            </Button>
          )}
        {phase === 'idle' &&
          visibleAttempts.map((attempt) => (
            <div
              key={attempt.id}
              className="bg-muted/30 w-full space-y-3 rounded-xl border p-4 text-left"
            >
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
        {onManualSetup && (
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-foreground h-auto px-0 py-1 text-xs hover:bg-transparent"
            onClick={onManualSetup}
          >
            Advanced: manual connection
          </Button>
        )}
      </div>
      <div className="bg-muted/30 border-t px-6 py-4 sm:px-8">
        <p className="text-muted-foreground text-xs leading-relaxed">
          You pay Meta directly for WhatsApp usage. RGCRM SaaS charges are
          separate. Signup does not confirm payment readiness. Configure your
          payment method in{' '}
          <a
            className="text-foreground decoration-border inline-flex items-center gap-1 font-medium underline underline-offset-4 hover:decoration-current"
            href="https://business.facebook.com/wa/manage/home/"
            target="_blank"
            rel="noopener noreferrer"
          >
            WhatsApp Manager{' '}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>{' '}
          under Payment settings for your WhatsApp account.
        </p>
      </div>
    </div>
  );
}
