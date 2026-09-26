import { describe, expect, it } from 'vitest';

import { hashInviteToken } from '@/lib/auth/invitations';
import {
  buildSignupMetadata,
  hashInviteTokenForSignup,
} from '@/lib/auth/invitation-token-client';

describe('hashInviteTokenForSignup', () => {
  it('matches the server-side invitation token hash', async () => {
    const token = 'invite-token-abc';

    expect(await hashInviteTokenForSignup(token)).toBe(hashInviteToken(token));
  });

  it('returns a lowercase 64-character SHA-256 hex digest', async () => {
    await expect(hashInviteTokenForSignup('hello')).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('keeps normal signup metadata unchanged', async () => {
    await expect(buildSignupMetadata('Normal User', null)).resolves.toEqual({
      full_name: 'Normal User',
    });
  });

  it('stores only the invite digest in signup metadata', async () => {
    const token = 'plaintext-secret-token';
    const metadata = await buildSignupMetadata('Invited User', token);

    expect(metadata).toEqual({
      full_name: 'Invited User',
      crm_invite_token_hash: hashInviteToken(token),
    });
    expect(JSON.stringify(metadata)).not.toContain(token);
  });
});
