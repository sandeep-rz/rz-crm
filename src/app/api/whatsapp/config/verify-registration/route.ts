import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  explainMetaError,
  metaErrorPayload,
} from '@/lib/whatsapp/meta-error-explain';
import { appSubscriptionState } from '@/lib/whatsapp/waba-pairing';
import { getSubscribedApps, verifyPhoneNumber } from '@/lib/whatsapp/meta-api';

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means the
 *                    number was saved but never actually subscribed
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // A workspace may have zero or more WhatsApp connections. Resolve the
  // caller's active account first, then select an explicit connection or
  // intentionally fall back to that workspace's primary connection.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'Your profile is not linked to an account.',
    });
  }

  const connectionId = new URL(request.url).searchParams.get('id');
  let configQuery = supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId);
  configQuery = connectionId
    ? configQuery.eq('id', connectionId)
    : configQuery.eq('is_primary', true);
  const { data: config } = await configQuery.maybeSingle();

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: 'No WhatsApp configuration saved yet.',
    });
  }

  let accessToken: string;
  try {
    accessToken = decrypt(config.access_token);
  } catch {
    return NextResponse.json({
      live: false,
      verified: false,
      needs_reset: true,
      reason: 'token_corrupted',
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        "Stored access token can't be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.",
    });
  }

  const checks: {
    config_exists: boolean;
    token_decryptable: boolean;
    phone_metadata_ok: boolean;
    waba_subscribed_to_app: boolean | null;
    locally_marked_registered: boolean;
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
  };
  const errors: string[] = [];

  let phoneInfo;
  let phoneFailure: ReturnType<typeof explainMetaError> | null = null;
  let wabaSubscription = {
    checked: false,
    subscribed: null as boolean | null,
    app_id_match: null as boolean | null,
  };

  // 1. Phone metadata
  try {
    phoneInfo = await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    });
    checks.phone_metadata_ok = true;
  } catch (err) {
    phoneFailure = explainMetaError(err, 'verify_number', {
      phoneNumberId: config.phone_number_id,
      wabaId: config.waba_id,
    });
    errors.push(phoneFailure.summary);
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      });
      const subscription = appSubscriptionState(subs, process.env.META_APP_ID);
      wabaSubscription = {
        checked: true,
        subscribed: subscription.subscribed,
        app_id_match: subscription.appIdMatch,
      };
      // Only a confirmed match for our configured app passes this check.
      checks.waba_subscribed_to_app = subscription.appIdMatch;
      if (!subscription.subscribed) {
        errors.push(
          'WABA has no subscribed apps. Re-save the configuration to subscribe.'
        );
      }
      if (subscription.appIdMatch === null) {
        errors.push(
          "META_APP_ID is not configured. Cannot verify this app's WABA subscription."
        );
      } else if (subscription.subscribed && !subscription.appIdMatch) {
        errors.push(
          'The configured Meta app is not subscribed to this WABA. Re-save the configuration to subscribe.'
        );
      }
    } catch (err) {
      wabaSubscription.checked = true;
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    errors.push(
      "No WABA ID on file — webhooks can't be wired without it. Add it in the form and re-save."
    );
  }

  const live =
    checks.phone_metadata_ok &&
    (checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered;

  return NextResponse.json(
    {
      live,
      verified: checks.phone_metadata_ok,
      checked_at: new Date().toISOString(),
      phone_info: phoneInfo ?? null,
      ...(phoneFailure
        ? {
            reason: 'meta_api_error',
            message: phoneFailure.summary,
            meta: metaErrorPayload(phoneFailure),
          }
        : {}),
      waba_subscription: wabaSubscription,
      checks,
      errors,
      last_registration_error: config.last_registration_error ?? null,
      registered_at: config.registered_at ?? null,
      subscribed_apps_at: config.subscribed_apps_at ?? null,
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}
