import { describe, expect, it } from 'vitest';

import { mergeAccountMemberRows } from './members';

describe('mergeAccountMemberRows', () => {
  const memberships = [
    {
      user_id: 'user-1',
      role: 'admin',
      joined_at: '2026-09-01T00:00:00.000Z',
    },
  ];
  const profiles = [
    {
      id: 'profile-1',
      user_id: 'user-1',
      full_name: 'Sandeep',
      email: 'sandeep@example.com',
      avatar_url: null,
    },
  ];

  it('uses membership role and joined_at while hydrating profile identity', () => {
    expect(mergeAccountMemberRows(memberships, profiles, true)).toEqual([
      {
        profile_id: 'profile-1',
        user_id: 'user-1',
        full_name: 'Sandeep',
        email: 'sandeep@example.com',
        avatar_url: null,
        role: 'admin',
        joined_at: '2026-09-01T00:00:00.000Z',
      },
    ]);
  });

  it('redacts email for callers below admin and drops invalid roles', () => {
    expect(
      mergeAccountMemberRows(memberships, profiles, false)[0].email
    ).toBeNull();
    expect(
      mergeAccountMemberRows(
        [{ ...memberships[0], role: 'future-role' }],
        profiles,
        true
      )
    ).toEqual([]);
  });
});
