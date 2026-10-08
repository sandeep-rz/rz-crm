/** Never accept SDK payloads, OAuth codes, tokens, or arbitrary error messages. */
export type SignupDiagnostic = {
  sdkVersion?: string;
  appId?: string;
  configId?: string;
  buffered?: boolean;
  userActivation?: boolean | null;
  trustedClick?: boolean;
  secureContext?: boolean;
  topLevel?: boolean;
  enforced?: boolean;
  directive?:
    | 'script-src'
    | 'script-src-elem'
    | 'connect-src'
    | 'frame-src'
    | 'default-src'
    | 'form-action';
  hasCode?: boolean;
  status?: 'connected' | 'not_authorized' | 'unknown';
  errorCode?: number;
  event?: 'FINISH' | 'CANCEL' | 'ERROR' | 'INCOMPLETE';
};
export function signupDiagnostic(
  event: string,
  details: SignupDiagnostic = {}
) {
  if (process.env.NODE_ENV === 'development')
    console.debug('[WhatsApp Embedded Signup]', event, details);
}
