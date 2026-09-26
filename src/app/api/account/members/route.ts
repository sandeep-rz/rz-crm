// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers } from "@/lib/auth/roles";
import {
  mergeAccountMemberRows,
  type AccountMemberProfileRow,
  type AccountMembershipRow,
} from "@/lib/account/members";

interface MembershipRow extends AccountMembershipRow {
  account_id: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // account_members is authoritative. profiles.account_id may point at a
    // different currently-active workspace for any member in this roster.
    const { data: membershipData, error: membershipError } = await ctx.supabase
      .from("account_members")
      .select("account_id, user_id, role, joined_at")
      .eq("account_id", ctx.accountId)
      .order("joined_at", { ascending: true });

    if (membershipError) {
      console.error("[GET /api/account/members] membership fetch error:", membershipError);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const memberships = (membershipData ?? []) as MembershipRow[];
    const userIds = memberships.map((row) => row.user_id);
    if (userIds.length === 0) return NextResponse.json({ members: [] });

    const { data: profileData, error: profileError } = await ctx.supabase
      .from("profiles")
      .select("id, user_id, full_name, email, avatar_url")
      .in("user_id", userIds);
    if (profileError) {
      console.error("[GET /api/account/members] profile fetch error:", profileError);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const members = mergeAccountMemberRows(
      memberships,
      (profileData ?? []) as AccountMemberProfileRow[],
      canManageMembers(ctx.role),
    );

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
