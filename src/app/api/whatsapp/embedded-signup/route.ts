import { createHash, randomUUID } from 'node:crypto';
import { decrypt } from '@/lib/whatsapp/encryption';
import { drainCoexistenceWebhook } from '@/lib/whatsapp/coexistence-webhook';
import { resumeCoexistenceSync } from '@/lib/whatsapp/coexistence-sync';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  requireRole,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/account';
import {
  signupContext,
  signupSessionContext,
  embeddedSignupConfig,
} from '@/lib/whatsapp/embedded-signup-context';
import {
  activateSignup,
  exchangeSignupCode,
  validateSignupToken,
  verifySignupActivation,
  SignupError,
} from '@/lib/whatsapp/embedded-signup';

export const runtime = 'nodejs';
export const maxDuration = 120;
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
const reply = (body: object, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await admin()
      .from('whatsapp_signup_attempts')
      .select(
        'id,connection_id,reconnect_id,context,created_at,state,lease_until,pending_access_token,expires_at'
      )
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .neq('state', 'complete')
      .is('discarded_at', null)
      .order('created_at', { ascending: false });
    if (error) throw new SignupError(503, 'Saved signup storage unavailable.');
    return reply({
      account_id: ctx.accountId,
      attempts: (data ?? []).map((a) => ({
        id: a.id,
        connection_id: a.connection_id,
        reconnect_id: a.reconnect_id,
        context: signupContext(a.context),
        created_at: a.created_at,
        recoverable: Boolean(
          a.pending_access_token &&
          signupContext(a.context) &&
          Date.parse(a.expires_at) > Date.now()
        ),
        busy:
          a.state === 'processing' &&
          Date.parse(a.lease_until) > Date.now() &&
          Date.parse(a.expires_at) > Date.now(),
      })),
    });
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError ||
      error instanceof SignupError
    )
      return reply({ error: error.message }, error.status);
    return reply({ error: 'Could not load saved signup attempts.' }, 503);
  }
}

export async function POST(request: Request) {
  let claimedId: string | undefined;
  let lease: string | undefined;
  try {
    if (
      request.headers.get('origin') !==
      new URL(process.env.NEXT_PUBLIC_SITE_URL || request.url).origin
    )
      return reply({ error: 'Invalid request origin' }, 403);
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object')
      return reply({ error: 'Invalid signup request' }, 400);
    const db = admin();
    if (body.action === 'discard') {
      if (!uuid(body.session_id))
        throw new SignupError(400, 'Invalid saved session.');
      const { error } = await db.rpc('discard_whatsapp_signup', {
        p_attempt: body.session_id,
        p_user: ctx.userId,
        p_account: ctx.accountId,
      });
      if (error)
        throw new SignupError(
          error.code === '42501' ? 403 : 409,
          'Saved setup could not be discarded. It may be active or unavailable for this user and workspace.'
        );
      return reply({ success: true });
    }
    if (body.action === 'sync') {
      if (!uuid(body.connection_id))
        throw new SignupError(400, 'Invalid connection.');
      const { data, error } = await ctx.supabase
        .from('whatsapp_config')
        .select('id')
        .eq('id', body.connection_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error || !data) throw new SignupError(404, 'Connection not found.');
      const { error: retryError } = await db
        .from('whatsapp_coexistence_events')
        .update({ attempts: 0, retry_at: new Date().toISOString() })
        .eq('connection_id', data.id)
        .eq('account_id', ctx.accountId)
        .is('processed_at', null);
      if (retryError)
        throw new SignupError(
          503,
          'Could not resume synchronization processing.'
        );
      const accepted = await resumeCoexistenceSync(db, data.id);
      await drainCoexistenceWebhook(db);
      return reply({ success: true, sync_pending: accepted === false });
    }
    if (body.action === 'start') {
      if (
        body.mode !== undefined &&
        !['cloud_api', 'coexistence'].includes(body.mode)
      )
        throw new SignupError(400, 'Invalid onboarding mode.');
      if (!(
        process.env.META_EMBEDDED_SIGNUP_APP_SECRET ||
        process.env.META_APP_SECRET
      ))
        throw new SignupError(503, 'WhatsApp onboarding is not configured.');
      if (body.reconnect_id !== undefined) {
        if (!uuid(body.reconnect_id))
          throw new SignupError(400, 'Invalid reconnect request.');
        const { data, error } = await ctx.supabase
          .from('whatsapp_config')
          .select('id')
          .eq('id', body.reconnect_id)
          .eq('account_id', ctx.accountId)
          .maybeSingle();
        if (error || !data) throw new SignupError(404, 'Connection not found.');
      }
      const { count, error: countError } = await db
        .from('whatsapp_signup_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', ctx.userId)
        .gte('created_at', new Date(Date.now() - 600_000).toISOString());
      if (countError) throw new SignupError(503, 'Signup storage unavailable.');
      if ((count ?? 0) >= 10)
        throw new SignupError(
          429,
          'Too many signup attempts. Try again in ten minutes.'
        );
      const { data, error } = await db
        .from('whatsapp_signup_attempts')
        .insert({
          user_id: ctx.userId,
          account_id: ctx.accountId,
          reconnect_id: body.reconnect_id ?? null,
          onboarding_mode: body.mode ?? 'cloud_api',
        })
        .select('id')
        .single();
      if (error) throw new SignupError(503, 'Could not start signup.');
      return reply({ session_id: data.id, ...embeddedSignupConfig });
    }
    const recovering = body.action === 'recover';
    if (!recovering && body.action !== 'complete')
      throw new SignupError(400, 'Invalid signup action.');
    const completionMode =
      body.completion_event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
        ? 'coexistence'
        : 'cloud_api';
    if (
      !recovering &&
      body.completion_event !== undefined &&
      !['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'].includes(
        body.completion_event
      )
    )
      throw new SignupError(400, 'Invalid completion event.');
    const incomingContext =
      completionMode === 'coexistence'
        ? signupSessionContext(body.context)
        : signupContext(body.context);
    if (
      !recovering &&
      (!uuid(body.session_id) ||
        !incomingContext ||
        typeof body.code !== 'string' ||
        !body.code.trim() ||
        body.code.length > 4096)
    )
      throw new SignupError(
        400,
        'Incomplete signup. A session, authorization code, WABA ID and phone number ID are required.'
      );
    if (recovering && !uuid(body.session_id) && !uuid(body.connection_id))
      throw new SignupError(400, 'A saved session or connection is required.');
    let query = db
      .from('whatsapp_signup_attempts')
      .select('*')
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId);
    query = uuid(body.session_id)
      ? query.eq('id', body.session_id)
      : query
          .eq('connection_id', body.connection_id)
          .not('pending_access_token', 'is', null)
          .neq('state', 'complete')
          .order('created_at', { ascending: false })
          .limit(1);
    const { data: attempt, error: readError } = await query.maybeSingle();
    if (readError || !attempt)
      throw new SignupError(
        404,
        'No saved signup is available for this user and workspace.'
      );
    const hash = recovering
      ? null
      : createHash('sha256').update(body.code).digest('hex');
    if (attempt.state === 'complete') {
      if (
        !recovering &&
        (attempt.code_hash !== hash ||
          attempt.context?.waba_id !== incomingContext?.waba_id ||
          (incomingContext?.phone_number_id &&
            attempt.context?.phone_number_id !==
              incomingContext.phone_number_id) ||
          (attempt.completion_mode &&
            attempt.completion_mode !== completionMode &&
            !(
              attempt.completion_mode === 'coexistence' &&
              attempt.pending_metadata?.onboarding_mode === 'coexistence'
            )))
      )
        throw new SignupError(409, 'Signup context mismatch.');
      return reply({ success: true, connection_id: attempt.connection_id });
    }
    lease = randomUUID();
    const { data: claims, error: claimError } = await db.rpc(
      'claim_whatsapp_signup',
      {
        p_attempt: attempt.id,
        p_user: ctx.userId,
        p_account: ctx.accountId,
        p_lease: lease,
        p_hash: hash,
        p_context: recovering ? null : incomingContext,
        p_mode: recovering ? null : completionMode,
      }
    );
    if (claimError || !claims?.[0])
      throw new SignupError(
        claimError?.code === '42501' ? 403 : 409,
        'Signup is busy, expired, or requires new authorization. After an interruption wait three minutes, then recover saved setup.'
      );
    const claimed = claims[0];
    if (claimed.state === 'complete')
      return reply({ success: true, connection_id: claimed.connection_id });
    claimedId = claimed.id;
    let context = signupSessionContext(claimed.context);
    let mode = claimed.completion_mode ?? 'cloud_api';
    if (!context) throw new SignupError(400, 'Invalid saved signup context.');
    const verified = claimed.pending_access_token
      ? await validateSignupToken(
          decrypt(claimed.pending_access_token),
          context,
          mode
        )
      : await exchangeSignupCode(body.code, context, mode);
    context = verified.context ?? signupContext(context);
    if (!context?.phone_number_id)
      throw new SignupError(400, 'Missing verified phone number.');
    const resolvedContext = {
      waba_id: context.waba_id,
      phone_number_id: context.phone_number_id,
    };
    if (!claimed.context?.phone_number_id) {
      const { error } = await db.rpc('resolve_whatsapp_signup_phone', {
        p_attempt: claimedId,
        p_lease: lease,
        p_phone: context.phone_number_id,
      });
      if (error)
        throw new SignupError(409, 'Could not save verified phone selection.');
    }
    const metadata = {
      method: 'embedded_signup',
      onboarding_mode: mode,
      display_phone_number: verified.displayPhone,
      waba_name: verified.wabaName,
      billing_status: 'not_verified',
      token_expires_at: verified.expiresAt,
    };
    const { data: connectionId, error: reserveError } = await db.rpc(
      'reserve_whatsapp_signup',
      {
        p_attempt: claimedId,
        p_lease: lease,
        p_phone: context.phone_number_id,
        p_waba: context.waba_id,
        p_token: verified.encryptedToken,
        p_metadata: metadata,
      }
    );
    if (reserveError)
      throw new SignupError(
        reserveError.code === '23505' ? 409 : 503,
        reserveError.code === '23505'
          ? 'This connection belongs to another account, has changed, or already has a saved signup. Recover its saved setup before starting another.'
          : 'Could not stage connection credentials.'
      );
    const assertLease = async () => {
      const { error } = await db.rpc('assert_whatsapp_signup_lease', {
        p_attempt: claimedId,
        p_lease: lease,
      });
      if (error)
        throw new SignupError(
          409,
          'The signup lease expired or changed. Recover saved setup to continue.'
        );
    };
    await assertLease();
    const activation = await activateSignup(
      resolvedContext,
      verified.token,
      {
        encryptedPin: claimed.pending_registration_pin,
        registrationRequested: Boolean(claimed.registration_requested_at),
      },
      assertLease,
      mode
    );
    if (
      'mode' in activation &&
      activation.mode === 'coexistence' &&
      mode !== 'coexistence'
    ) {
      const { error } = await db.rpc('mark_whatsapp_signup_coexistence', {
        p_attempt: claimedId,
        p_lease: lease,
      });
      if (error)
        throw new SignupError(
          409,
          'Could not save verified Business app mode. Recover saved setup.'
        );
      mode = 'coexistence';
    }
    if (activation.needsRegistration) {
      // Atomically verify the current, unexpired lease and persist one registration
      // intent. Reclaimed leases can only reconcile an existing uncertain intent.
      const { error } = await db.rpc('mark_whatsapp_registration', {
        p_attempt: claimedId,
        p_lease: lease,
        p_encrypted_pin: activation.encryptedPin,
      });
      if (error)
        throw new SignupError(
          409,
          'Registration lease changed or a previous attempt needs reconciliation. Recover saved setup.'
        );
      await activation.register();
    }
    const activationState = await verifySignupActivation(
      resolvedContext,
      verified.token,
      mode
    );
    await assertLease();
    const { error: finishError } = await db.rpc('finish_whatsapp_signup', {
      p_attempt: claimedId,
      p_lease: lease,
      p_registered_at: activationState.registeredAt,
      p_subscribed_at: activationState.subscribedAt,
    });
    if (finishError)
      throw new SignupError(
        503,
        'Meta setup was verified but database finalization needs recovery. Use Recover saved setup; a new Facebook authorization is not required.'
      );
    if (mode === 'coexistence') {
      // A sync failure must not misreport an already connected account as failed.
      try {
        if ((await resumeCoexistenceSync(db, connectionId)) === false)
          return reply({
            success: true,
            connection_id: connectionId,
            sync_pending: true,
          });
      } catch {
        return reply({
          success: true,
          connection_id: connectionId,
          sync_pending: true,
        });
      }
    }
    return reply({ success: true, connection_id: connectionId });
  } catch (error) {
    if (claimedId) {
      // Release only our lease; staged credentials remain durable for recovery.
      await admin()
        .rpc('release_whatsapp_signup', {
          p_attempt: claimedId,
          p_lease: lease,
        })
        .then(
          () => {},
          () => {}
        );
    }
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError ||
      error instanceof SignupError
    )
      return reply({ error: error.message }, error.status);
    return reply(
      {
        error:
          'WhatsApp setup could not complete. Use Recover saved setup if credentials have already been saved.',
      },
      502
    );
  }
}
