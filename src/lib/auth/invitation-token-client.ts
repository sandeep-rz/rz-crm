/**
 * Browser-safe SHA-256 used only to mark an invitation-origin signup.
 *
 * Invitation token generation stays server-only in invitations.ts. The
 * plaintext token is hashed before it enters Supabase user metadata, and the
 * digest intentionally matches hashInviteToken() on the server.
 */
export async function hashInviteTokenForSignup(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export interface SignupMetadata {
  full_name: string;
  crm_invite_token_hash?: string;
}

/** Build auth metadata without ever including the plaintext invite token. */
export async function buildSignupMetadata(
  fullName: string,
  inviteToken: string | null
): Promise<SignupMetadata> {
  return {
    full_name: fullName,
    ...(inviteToken
      ? { crm_invite_token_hash: await hashInviteTokenForSignup(inviteToken) }
      : {}),
  };
}
