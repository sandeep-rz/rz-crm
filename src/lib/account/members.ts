import type { AccountMember } from '@/types';
import { isAccountRole } from '@/lib/auth/roles';

export interface AccountMembershipRow {
  user_id: string;
  role: string;
  joined_at: string;
}

export interface AccountMemberProfileRow {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

/** Membership owns role/joined_at; profiles only hydrate display identity. */
export function mergeAccountMemberRows(
  memberships: AccountMembershipRow[],
  profiles: AccountMemberProfileRow[],
  canSeeEmails: boolean,
): AccountMember[] {
  const profilesByUserId = new Map(profiles.map((row) => [row.user_id, row]));

  return memberships.flatMap((membership) => {
    if (!isAccountRole(membership.role)) return [];
    const profile = profilesByUserId.get(membership.user_id);
    if (!profile) return [];
    return [{
      profile_id: profile.id,
      user_id: membership.user_id,
      full_name: profile.full_name ?? '',
      email: canSeeEmails ? profile.email : null,
      avatar_url: profile.avatar_url,
      role: membership.role,
      joined_at: membership.joined_at,
    }];
  });
}

/**
 * Fetch the current account's members from the API (which applies the
 * email-visibility rules — agents/viewers don't see emails). Best-effort:
 * returns `[]` on any error or on an older deployment without the
 * endpoint, so callers can fall back to a queue-only / raw-id picker.
 *
 * Client-side only (uses `fetch` against the relative API route).
 */
export async function fetchAccountMembers(): Promise<AccountMember[]> {
  try {
    const res = await fetch('/api/account/members', { cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as { members?: AccountMember[] };
    return json.members ?? [];
  } catch {
    return [];
  }
}

/** Display label for a member: full name → email → raw id. */
export function memberLabel(m: AccountMember): string {
  return m.full_name || m.email || m.user_id;
}
