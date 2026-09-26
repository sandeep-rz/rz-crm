import type { AccountMembership } from '@/types';

/**
 * UX mirror of migration 045. The create_workspace RPC remains the security
 * boundary and repeats this check against account_members in Postgres.
 */
export function canCreateWorkspaceFromMemberships(
  memberships: Pick<AccountMembership, 'role'>[]
): boolean {
  return (
    memberships.length === 0 ||
    memberships.some((membership) => membership.role === 'owner')
  );
}
