/** Session events are hints only; the backend independently proves asset access. */
export type SignupMode = 'cloud_api' | 'coexistence';
export type SignupSessionContext = {
  waba_id: string;
  phone_number_id?: string;
};
export type SignupContext = { waba_id: string; phone_number_id: string };
export function signupSessionContext(
  value: unknown
): SignupSessionContext | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    !metaId(v.waba_id) ||
    (v.phone_number_id !== undefined && !metaId(v.phone_number_id))
  )
    return null;
  return {
    waba_id: v.waba_id,
    ...(v.phone_number_id
      ? { phone_number_id: v.phone_number_id as string }
      : {}),
  };
}
export function signupLaunchOptions(mode: SignupMode) {
  return {
    config_id: embeddedSignupConfig.configId,
    response_type: 'code',
    override_default_response_type: true,
    extras:
      mode === 'coexistence'
        ? {
            setup: {},
            featureType: 'whatsapp_business_app_onboarding',
            sessionInfoVersion: '3',
          }
        : { setup: {} },
  };
}
export function signupEligibilityError(code?: number) {
  if (code === 2494064 || code === 3441034)
    return `Meta blocked onboarding (${code}). Check number eligibility, existing provider access and the app’s Tech Provider approval with Meta support. Keep any AiSensy or other provider connection in place until an approved transfer path is confirmed.`;
  return `Meta reported a signup error${Number.isSafeInteger(code) ? ` (${code})` : ''}. Check eligibility and Login for Business settings, then retry.`;
}
const metaId = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,30}$/.test(v);
export function signupContext(value: unknown): SignupContext | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return metaId(v.waba_id) && metaId(v.phone_number_id)
    ? { waba_id: v.waba_id, phone_number_id: v.phone_number_id }
    : null;
}
export function signupEvent(origin: string, value: unknown) {
  if (
    !['https://www.facebook.com', 'https://web.facebook.com'].includes(origin)
  )
    return null;
  try {
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !v ||
      v.type !== 'WA_EMBEDDED_SIGNUP' ||
      ![
        'FINISH',
        'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
        'CANCEL',
        'ERROR',
      ].includes(v.event)
    )
      return null;
    if (
      v.event === 'FINISH' ||
      v.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
    ) {
      const coexistence = v.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
      const context = coexistence
        ? signupSessionContext(v.data)
        : signupContext(v.data);
      return context
        ? {
            event: v.event as
              'FINISH' | 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
            context,
          }
        : { event: 'INCOMPLETE' as const };
    }
    return {
      event: v.event as 'CANCEL' | 'ERROR',
      ...(v.event === 'ERROR' && typeof v.data?.error_code === 'number'
        ? { errorCode: v.data.error_code }
        : {}),
    };
  } catch {
    return null;
  }
}
export const embeddedSignupConfig = {
  appId: '1444327167651307',
  configId: '1445638484111991',
  // Matches this app's Meta Embedded Signup Builder SDK initialization snippet.
  // This is independent of the existing server-side Graph API version.
  sdkVersion: 'v26.0',
};

/** Safe browser summary; credentials, code hashes and PINs stay server-side. */
export type SavedSignupAttempt = {
  id: string;
  connection_id: string | null;
  reconnect_id: string | null;
  context: SignupContext | null;
  created_at: string;
  recoverable: boolean;
  busy: boolean;
};
