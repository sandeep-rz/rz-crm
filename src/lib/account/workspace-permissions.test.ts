import { describe, expect, it } from 'vitest';

import { canCreateWorkspaceFromMemberships } from '@/lib/account/workspace-permissions';

describe('canCreateWorkspaceFromMemberships', () => {
  it('allows the zero-membership recovery path', () => {
    expect(canCreateWorkspaceFromMemberships([])).toBe(true);
  });

  it.each(['admin', 'agent', 'viewer'] as const)(
    'hides creation for a team-only %s',
    (role) => {
      expect(canCreateWorkspaceFromMemberships([{ role }])).toBe(false);
    }
  );

  it('allows an owner even when they are an agent elsewhere', () => {
    expect(
      canCreateWorkspaceFromMemberships([{ role: 'owner' }, { role: 'agent' }])
    ).toBe(true);
  });
});
