import { randomInt } from 'node:crypto';
import { decrypt, encrypt } from './encryption';
import { parseAppSecrets } from './webhook-signature';
import {
  getSubscribedApps,
  listWabaPhoneNumbers,
  subscribeWabaToApp,
} from './meta-api';
import {
  embeddedSignupConfig,
  type SignupContext,
} from './embedded-signup-context';

export class SignupError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
const base = 'https://graph.facebook.com/v21.0';
/** Never propagate raw Meta errors: they can echo credentials or request parameters. */
async function graph(path: string, token: string, init?: RequestInit) {
  try {
    const response = await fetch(`${base}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init?.headers },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error();
    return result;
  } catch {
    throw new SignupError(
      502,
      'Meta could not complete this step. Recover saved setup when available, or retry signup.'
    );
  }
}
function signupSecret() {
  const secret =
    process.env.META_EMBEDDED_SIGNUP_APP_SECRET || process.env.META_APP_SECRET;
  if (
    !secret ||
    secret.includes(',') ||
    !parseAppSecrets(process.env.META_APP_SECRET).includes(secret)
  )
    throw new SignupError(
      503,
      'WhatsApp onboarding is not configured. Contact your administrator.'
    );
  return secret;
}
export async function exchangeSignupCode(code: string, context: SignupContext) {
  const secret = signupSecret();
  let exchanged;
  try {
    // POST keeps the authorization code and app secret out of request URLs/access logs.
    exchanged = await graph(
      'oauth/access_token',
      `${embeddedSignupConfig.appId}|${secret}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: embeddedSignupConfig.appId,
          client_secret: secret,
          code,
        }),
      }
    );
  } catch {
    throw new SignupError(
      400,
      'The Facebook authorization code expired or could not be exchanged. Start signup again.'
    );
  }
  if (typeof exchanged.access_token !== 'string' || !exchanged.access_token)
    throw new SignupError(
      400,
      'Facebook did not return a business access token. Start signup again.'
    );
  const token = exchanged.access_token as string;
  return validateSignupToken(token, context);
}

export async function validateSignupToken(
  token: string,
  context: SignupContext
) {
  const { data } = await graph(
    `debug_token?input_token=${encodeURIComponent(token)}`,
    `${embeddedSignupConfig.appId}|${signupSecret()}`
  );
  const now = Math.floor(Date.now() / 1000);
  if (
    !data?.is_valid ||
    data.app_id !== embeddedSignupConfig.appId ||
    data.type !== 'SYSTEM_USER' ||
    !['whatsapp_business_management', 'whatsapp_business_messaging'].every(
      (scope) => data.scopes?.includes(scope)
    ) ||
    (data.expires_at && data.expires_at <= now) ||
    (data.data_access_expires_at && data.data_access_expires_at <= now)
  )
    throw new SignupError(
      400,
      'Facebook authorization is invalid or missing required WhatsApp permissions. Start signup again.'
    );
  const waba = await graph(`${context.waba_id}?fields=id,name`, token);
  const numbers = await listWabaPhoneNumbers({
    wabaId: context.waba_id,
    accessToken: token,
    signal: AbortSignal.timeout(15_000),
  });
  const phone = numbers.find((number) => number.id === context.phone_number_id);
  if (waba.id !== context.waba_id || !phone?.display_phone_number)
    throw new SignupError(
      400,
      'The selected phone number does not belong to the authorized WhatsApp account.'
    );
  return {
    token,
    encryptedToken: encrypt(token),
    wabaName: String(waba.name || context.waba_id).slice(0, 200),
    displayPhone: phone.display_phone_number,
    expiresAt: data.expires_at
      ? new Date(data.expires_at * 1000).toISOString()
      : null,
  };
}
export async function activateSignup(
  context: SignupContext,
  token: string,
  recovery:
    | { encryptedPin?: string | null; registrationRequested?: boolean }
    | undefined,
  assertLease: () => Promise<void>
) {
  const args = {
    wabaId: context.waba_id,
    accessToken: token,
    signal: AbortSignal.timeout(30_000),
  };
  const isSubscribed = (apps: Awaited<ReturnType<typeof getSubscribedApps>>) =>
    apps.some(
      (app) => app.whatsapp_business_api_data?.id === embeddedSignupConfig.appId
    );
  // Reconcile actual state before any mutation, including after an interrupted request.
  if (!isSubscribed(await getSubscribedApps(args))) {
    await assertLease();
    await subscribeWabaToApp(args);
    if (!isSubscribed(await getSubscribedApps(args)))
      throw new SignupError(
        502,
        'Meta webhook subscription could not be verified. Recover saved setup to retry.'
      );
  }
  const subscribedAt = new Date().toISOString();
  const readPhone = async () => {
    const phone = await graph(
      `${context.phone_number_id}?fields=id,status,display_phone_number`,
      token
    );
    if (phone.id !== context.phone_number_id)
      throw new SignupError(400, 'Meta returned a different phone number.');
    return phone;
  };
  const phone = await readPhone();
  if (phone.status !== 'CONNECTED') {
    if (recovery?.registrationRequested)
      throw new SignupError(
        409,
        'A previous registration request has an unconfirmed outcome. Check WhatsApp Manager, then recover saved setup to verify again.'
      );
    const pin = recovery?.encryptedPin
      ? decrypt(recovery.encryptedPin)
      : randomInt(0, 1_000_000).toString().padStart(6, '0');
    return {
      needsRegistration: true as const,
      subscribedAt,
      encryptedPin: recovery?.encryptedPin || encrypt(pin),
      register: async () => {
        await assertLease();
        const result = await graph(
          `${context.phone_number_id}/register`,
          token,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
          }
        );
        if (result.success !== true)
          throw new SignupError(
            502,
            'Phone registration failed. Recover saved setup to check its state.'
          );
        if ((await readPhone()).status !== 'CONNECTED')
          throw new SignupError(
            502,
            'Meta has not confirmed phone registration. Recover saved setup to verify again.'
          );
        return new Date().toISOString();
      },
    };
  }
  return {
    needsRegistration: false as const,
    registeredAt: new Date().toISOString(),
    subscribedAt,
  };
}

/** Read-only final barrier, including subscription verification AFTER registration. */
export async function verifySignupActivation(
  context: SignupContext,
  token: string
) {
  const apps = await getSubscribedApps({
    wabaId: context.waba_id,
    accessToken: token,
    signal: AbortSignal.timeout(15_000),
  });
  if (
    !apps.some(
      (app) => app.whatsapp_business_api_data?.id === embeddedSignupConfig.appId
    )
  )
    throw new SignupError(
      502,
      'Meta webhook subscription is not verified. Recover saved setup to retry.'
    );
  const subscribedAt = new Date().toISOString();
  const phone = await graph(
    `${context.phone_number_id}?fields=id,status`,
    token
  );
  if (phone.id !== context.phone_number_id || phone.status !== 'CONNECTED')
    throw new SignupError(
      502,
      'Meta phone registration is not verified. Recover saved setup to retry.'
    );
  return { registeredAt: new Date().toISOString(), subscribedAt };
}
