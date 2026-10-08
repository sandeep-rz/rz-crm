/** Session events are hints only; the backend independently proves asset access. */
export type SignupContext = { waba_id: string; phone_number_id: string };
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
      !['FINISH', 'CANCEL', 'ERROR'].includes(v.event)
    )
      return null;
    if (v.event === 'FINISH') {
      const context = signupContext(v.data);
      return context
        ? { event: 'FINISH' as const, context }
        : { event: 'INCOMPLETE' as const };
    }
    return { event: v.event as 'CANCEL' | 'ERROR' };
  } catch {
    return null;
  }
}
export const embeddedSignupConfig = {
  appId: '1444327167651307',
  configId: '1392665409205658',
  sdkVersion: 'v21.0',
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
