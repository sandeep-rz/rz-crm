'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Four UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + signup  │
//   │ ok:true              │ signed out    │ "Sign up" + "Sign in"    │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
// Auto-redeem would also race with the signup flow returning to
// this page after email verification.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { createClient } from '@/lib/supabase/client';

interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  expires_at: string;
}
interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error';
}
type PeekResult = PeekOk | PeekFail;

// Message keys per peek failure reason — resolved through `t` inside
// the component (hooks can't run at module level). Snake_case reasons
// come from the API; the catalogue uses camelCase leaves.
const FAIL_KEY: Record<
  PeekFail['reason'],
  'notFound' | 'used' | 'expired' | 'serverError'
> = {
  not_found: 'notFound',
  used: 'used',
  expired: 'expired',
  server_error: 'serverError',
};

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const t = useTranslations('JoinPage');
  // Role labels are shared with Settings → Members so the invite page
  // and the member list always agree on what a role is called.
  const tRoles = useTranslations('Settings.roles');

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page. We hit Supabase
  // directly the same way `/login` and `/signup` do.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined // undefined = unknown / still loading; null = signed out
  );
  const [accepting, setAccepting] = useState(false);

  // Extracted so the "Try again" button on the server_error card
  // can re-run the same logic without remounting the component.
  const loadPeekAndAuth = useCallback(async () => {
    if (!token) return;
    setPeek(null);
    setAuthedUserId(undefined);
    try {
      const [peekRes, authRes] = await Promise.all([
        fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
          cache: 'no-store',
        }),
        createClient().auth.getUser(),
      ]);
      const peekBody = (await peekRes.json()) as PeekResult;
      setPeek(peekBody);
      setAuthedUserId(authRes.data.user?.id ?? null);
    } catch (err) {
      console.error('[join] peek error:', err);
      setPeek({ ok: false, reason: 'server_error' });
      setAuthedUserId(null);
    }
  }, [token]);

  // Fetch peek + auth state on mount. The peek endpoint is
  // rate-limited per-IP (30/min) so double-mounting in React 19
  // strict mode dev is harmless. We also use the `cancelled` flag
  // to drop setState calls if the component unmounts mid-fetch.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [peekRes, authRes] = await Promise.all([
          fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
            cache: 'no-store',
          }),
          createClient().auth.getUser(),
        ]);
        const peekBody = (await peekRes.json()) as PeekResult;
        if (cancelled) return;
        setPeek(peekBody);
        setAuthedUserId(authRes.data.user?.id ?? null);
      } catch (err) {
        console.error('[join] peek error:', err);
        if (cancelled) return;
        setPeek({ ok: false, reason: 'server_error' });
        setAuthedUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        // Under migration 043, a conflict only means this same user already
        // belongs to the invited workspace; other memberships are allowed.
        toast.error(payload.error || t('acceptFailed'));
        setAccepting(false);
        return;
      }
      toast.success(t('welcome'));
      // Full reload (not router.push) so AuthProvider re-fetches
      // the profile with the new account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error(t('serverUnreachable'));
      setAccepting(false);
    }
  }, [token, t]);

  // ----- Loading state (peek pending OR auth not yet resolved) -----
  if (peek === null || authedUserId === undefined) {
    return (
      <Card className="border-border bg-card w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
          <p className="text-muted-foreground text-sm">{t('verifying')}</p>
        </CardContent>
      </Card>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    const failKey = FAIL_KEY[peek.reason];
    return (
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <MailX className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-foreground text-xl">
            {t(`fail.${failKey}Title`)}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t(`fail.${failKey}Body`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {/* For server_error the failure is transient — the network
              flapped or the peek endpoint hiccupped. Try-again is
              the right primary action; the "create account" /
              "sign in" links stay as secondary options. Other
              failure reasons (not_found / used / expired) are
              terminal for this token, so no retry — just the
              signup/sign-in escape hatches. */}
          {peek.reason === 'server_error' ? (
            <>
              <Button
                onClick={loadPeekAndAuth}
                className="bg-primary text-primary-foreground hover:bg-primary/90 w-full"
              >
                {t('tryAgain')}
              </Button>
              <Link href="/signup">
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground w-full"
                >
                  {t('createNewAccount')}
                </Button>
              </Link>
            </>
          ) : (
            <>
              <Link href="/signup">
                <Button className="bg-primary text-primary-foreground hover:bg-primary/90 w-full">
                  {t('createNewAccount')}
                </Button>
              </Link>
              <Link href="/login">
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground w-full"
                >
                  {t('signIn')}
                </Button>
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  // ----- Peek OK -----
  const inviteHeader = (
    <CardHeader className="items-center text-center">
      <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
        <UsersRound className="text-primary h-6 w-6" />
      </div>
      <CardTitle className="text-foreground text-xl">
        {t.rich('invitedTo', {
          name: peek.account_name,
          account: (chunks) => <span className="text-primary">{chunks}</span>,
        })}
      </CardTitle>
      <CardDescription className="text-muted-foreground">
        {t.rich('joinAs', {
          role: tRoles(peek.role),
          date: new Date(peek.expires_at).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          }),
          badge: (chunks) => (
            <span className="text-foreground inline-flex items-center gap-1">
              <ShieldCheck className="text-primary size-3.5" />
              {chunks}
            </span>
          ),
        })}
      </CardDescription>
    </CardHeader>
  );

  // ----- Authed: show Accept button -----
  if (authedUserId) {
    return (
      <>
        <Card className="border-border bg-card w-full max-w-md">
          {inviteHeader}
          <CardContent className="flex flex-col gap-3">
            <Button
              onClick={handleAccept}
              disabled={accepting}
              className="bg-primary text-primary-foreground hover:bg-primary/90 w-full"
            >
              {accepting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('accepting')}
                </>
              ) : (
                <>
                  <CheckCircle className="size-4" />
                  {t('acceptInvitation')}
                </>
              )}
            </Button>
            <p className="text-muted-foreground text-center text-xs">
              {t('acceptNote', { name: peek.account_name })}
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  // ----- Not authed: prompt to sign up or sign in -----
  return (
    <Card className="border-border bg-card w-full max-w-md">
      {inviteHeader}
      <CardContent className="flex flex-col gap-2">
        <Link href={`/signup?invite=${encodeURIComponent(token!)}`}>
          <Button className="bg-primary text-primary-foreground hover:bg-primary/90 w-full">
            {t('createAndJoin')}
          </Button>
        </Link>
        <Link href={`/login?invite=${encodeURIComponent(token!)}`}>
          <Button
            variant="outline"
            className="border-border text-muted-foreground hover:bg-muted hover:text-foreground w-full"
          >
            {t('haveAccount')}
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
