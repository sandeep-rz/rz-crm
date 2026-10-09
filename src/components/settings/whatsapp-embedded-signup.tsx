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
import { signupDiagnostic } from '@/lib/whatsapp/embedded-signup-diagnostics';
import {
  signupEvent,
  signupLaunchOptions,
  signupEligibilityError,
  type SignupMode,
  type SignupSessionContext,
  embeddedSignupConfig,
  type SavedSignupAttempt,
} from '@/lib/whatsapp/embedded-signup-context';

type FacebookResponse = {
  authResponse?: { code?: string };
  status?: string;
  error?: { code?: number };
};
type Facebook = {
  /** Meta's bootstrap object queues calls until the full bundle replaces it. */
  __buffer?: unknown;
  init: (options: object) => void;
  login: (
    callback: (response?: FacebookResponse | null) => void,
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
      signupDiagnostic('sdk_error');
      reject(error);
    };
    const loaded = () => {
      if (settled) return;
      try {
        if (!window.FB || window.FB.__buffer)
          throw new Error('Facebook SDK unavailable.');
        window.FB.init({
          appId: embeddedSignupConfig.appId,
          version: embeddedSignupConfig.sdkVersion,
          autoLogAppEvents: false,
          xfbml: false,
          // Login for Business configurations are not supported by FedCM.
          // Explicit false also prevents the SDK's cached app-config default
          // from switching this integration away from the popup flow.
          fedCM: false,
        });
        signupDiagnostic('fb_init_completed', {
          sdkVersion: embeddedSignupConfig.sdkVersion,
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
    if (window.FB && !window.FB.__buffer) return loaded();
    // Meta's generated async loader initializes through this callback only.
    window.fbAsyncInit = loaded;
    // A pre-existing bootstrap stub means Meta's full bundle is still loading.
    // Do not initialize or capture that stub, and do not inject a second SDK.
    if (window.FB?.__buffer) return;
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.onload = () => {
      signupDiagnostic('sdk_script_loaded', {
        buffered: Boolean(window.FB?.__buffer),
      });
      // sdk.js is only a bootstrap loader. Its onload is NOT SDK readiness.
      // Only fbAsyncInit may initialize and resolve the full SDK here.
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
    'idle' | 'preparing' | 'ready' | 'signup' | 'unconfirmed' | 'saving'
  >('idle');
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<SignupMode>('cloud_api');
  const prepared = useRef<{ session: string; fb: Facebook } | null>(null);
  const run = useRef<{
    code?: string;
    context?: SignupSessionContext;
    completionEvent?: string;
    submitted: boolean;
    responded: boolean;
  } | null>(null);
  const launchWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLaunchWatchdog = () => {
    if (launchWatchdog.current) clearTimeout(launchWatchdog.current);
    launchWatchdog.current = null;
  };
  const [recoverySession, setRecoverySession] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      run.current = null;
      clearLaunchWatchdog();
    };
  }, []);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const violation = (event: SecurityPolicyViolationEvent) => {
      const directive = event.effectiveDirective;
      if (
        directive === 'script-src' ||
        directive === 'script-src-elem' ||
        directive === 'connect-src' ||
        directive === 'frame-src' ||
        directive === 'default-src' ||
        directive === 'form-action'
      )
        signupDiagnostic('csp_violation', {
          directive,
          enforced: event.disposition === 'enforce',
        });
      // Never log blockedURI or source URLs: they can contain credentials.
    };
    window.addEventListener('securitypolicyviolation', violation);
    return () =>
      window.removeEventListener('securitypolicyviolation', violation);
  }, []);
  const stop = (text: string) => {
    clearLaunchWatchdog();
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
        completion_event: current.completionEvent,
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
      const result = signupEvent(event.origin, event.data);
      if (!result) return;
      signupDiagnostic('wa_embedded_signup_event', { event: result.event });
      if (!run.current || run.current.submitted) return;
      clearLaunchWatchdog();
      run.current.responded = true;
      if (
        result.event === 'FINISH' ||
        result.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
      ) {
        setPhase('unconfirmed');
        setMessage(
          'WhatsApp details received. Finish Facebook authorization in the popup. If the popup has already closed, retry or cancel signup.'
        );
        run.current.context = result.context;
        run.current.completionEvent = result.event;
        void complete();
      } else {
        signupDiagnostic('signup_cancelled_or_error', { event: result.event });
        stop(
          result.event === 'CANCEL'
            ? 'Signup cancelled. You can try again.'
            : result.event === 'INCOMPLETE'
              ? 'Signup did not return both a WhatsApp account and number. Start again.'
              : signupEligibilityError(
                  'errorCode' in result ? result.errorCode : undefined
                )
        );
      }
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
        mode,
        ...(reconnectId ? { reconnect_id: reconnectId } : {}),
      });
      if (alive.current) {
        prepared.current = { fb, session: data.session_id };
        signupDiagnostic('signup_ready', {
          sdkVersion: embeddedSignupConfig.sdkVersion,
          appId: embeddedSignupConfig.appId,
          configId: embeddedSignupConfig.configId,
          buffered: Boolean(fb.__buffer),
        });
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
  function launch(event?: { isTrusted?: boolean }) {
    if (!prepared.current || prepared.current.fb.__buffer) {
      signupDiagnostic('sdk_not_ready');
      stop('Facebook SDK is not ready. Reload the page and retry.');
      return;
    }
    clearLaunchWatchdog();
    setPhase('signup');
    setMessage(
      'Complete signup in the Facebook popup. You can take your time or cancel here. If it does not open, allow popups and retry.'
    );
    const current = { submitted: false, responded: false };
    run.current = current;
    try {
      // Must run synchronously from the click to retain browser popup permission.
      signupDiagnostic('fb_login_invoked', {
        sdkVersion: embeddedSignupConfig.sdkVersion,
        appId: embeddedSignupConfig.appId,
        configId: embeddedSignupConfig.configId,
        userActivation: navigator.userActivation?.isActive ?? null,
        trustedClick: event?.isTrusted ?? false,
        secureContext: window.isSecureContext,
        topLevel: window.top === window.self,
      });
      prepared.current.fb.login((response) => {
        const status = response?.status;
        const errorCode = response?.error?.code;
        signupDiagnostic('fb_login_callback', {
          hasCode: Boolean(response?.authResponse?.code),
          ...(status === 'connected' ||
          status === 'not_authorized' ||
          status === 'unknown'
            ? { status }
            : {}),
          ...(typeof errorCode === 'number' && Number.isFinite(errorCode)
            ? { errorCode }
            : {}),
        });
        if (run.current !== current || current.submitted) return;
        clearLaunchWatchdog();
        current.responded = true;
        if (response?.error) {
          signupDiagnostic('fb_login_error');
          stop(signupEligibilityError(response.error.code));
          return;
        }
        if (!response?.authResponse?.code) {
          signupDiagnostic('fb_login_cancelled');
          stop(
            'Facebook authorization was cancelled or incomplete. Start again.'
          );
          return;
        }
        run.current.code = response.authResponse.code;
        setPhase('unconfirmed');
        setMessage(
          'Facebook authorization received. Finish selecting your WhatsApp account and number in the popup. If the popup has already closed, retry or cancel signup.'
        );
        void complete();
      }, signupLaunchOptions(mode));
      // This only changes the silent-launch UI. It does not cancel an open,
      // long-running interaction, discard the session, or reject late callbacks.
      if (run.current === current && !current.responded && !current.submitted) {
        launchWatchdog.current = setTimeout(() => {
          if (
            !alive.current ||
            run.current !== current ||
            current.responded ||
            current.submitted
          )
            return;
          signupDiagnostic('popup_launch_unconfirmed');
          setPhase('unconfirmed');
          setMessage(
            'Facebook has not confirmed the launch. If its popup is open, continue there. Otherwise use Popup didn’t open? to retry, or cancel. Check browser blockers and Meta’s allowed SDK domains if it persists.'
          );
        }, 10_000);
      }
    } catch {
      signupDiagnostic('fb_login_exception');
      stop(
        'Facebook popup could not open. Check browser blockers and Meta’s Login for Business settings, then retry.'
      );
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
        <fieldset
          disabled={phase !== 'idle'}
          className="w-full space-y-3 text-left"
        >
          <legend className="text-sm font-semibold">
            Choose your connection method
          </legend>
          {(
            [
              [
                'coexistence',
                'Connect my WhatsApp Business App',
                'Recommended if you already use the mobile app. Keep using your existing WhatsApp Business app while connecting it to RGCRM for CRM messaging and automation.',
              ],
              [
                'cloud_api',
                'Connect a new WhatsApp number',
                'Connect a new or eligible WhatsApp number directly to RGCRM through Meta.',
              ],
            ] as const
          ).map(([value, label, description]) => (
            <label key={value} className="flex gap-3 rounded-xl border p-4">
              <input
                type="radio"
                name={`signup-mode-${reconnectId || 'new'}`}
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="text-muted-foreground text-xs">
                  {description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === 'coexistence' && (
          <p className="text-muted-foreground text-left text-xs leading-relaxed">
            Meta decides number eligibility. Keep the Business app open during
            synchronization. You choose whether to share chat history in Meta;
            eligible one-to-one history may be imported, but groups and some app
            features are unavailable in RGCRM. Older media may be missing.
            Linked devices may need reconnecting and some app features change.
            Get customer consent before CRM messaging. Cloud API messages have
            Meta charges and messaging-window rules. A number already using
            AiSensy or another provider needs its supported transfer path
            checked first.
          </p>
        )}
        <div
          className={cn(
            'flex flex-wrap items-center gap-3',
            prominent && 'justify-center'
          )}
        >
          <Button
            className="h-12 gap-3 rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white shadow-md shadow-emerald-600/15 transition-all hover:bg-emerald-700 hover:shadow-lg hover:shadow-emerald-600/20 motion-safe:hover:-translate-y-0.5 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            disabled={['preparing', 'signup', 'unconfirmed', 'saving'].includes(
              phase
            )}
            onClick={phase === 'ready' ? launch : () => void prepare()}
          >
            {['preparing', 'signup', 'saving'].includes(phase) ? (
              <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            ) : (
              <MessageCircle aria-hidden="true" className="size-5" />
            )}
            {phase === 'unconfirmed'
              ? 'Check Facebook popup'
              : phase === 'ready'
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
            {!['preparing', 'signup', 'unconfirmed', 'saving'].includes(
              phase
            ) && <ArrowRight aria-hidden="true" className="size-4" />}
          </Button>
          {(phase === 'signup' || phase === 'unconfirmed') && (
            <Button
              variant="outline"
              onClick={() => {
                signupDiagnostic('ui_cancelled');
                stop('Signup cancelled. You can try again.');
              }}
            >
              Cancel signup
            </Button>
          )}
          {(phase === 'signup' || phase === 'unconfirmed') && (
            <Button
              variant="outline"
              onClick={() => {
                // Invalidate this callback pair before retrying. Keep the durable
                // session; retry must be another direct click, without network work.
                clearLaunchWatchdog();
                signupDiagnostic('popup_retry_requested');
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
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer py-1">Advanced Options</summary>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-foreground h-auto px-0 py-1 text-xs hover:bg-transparent"
              onClick={onManualSetup}
            >
              Manual connection
            </Button>
          </details>
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
