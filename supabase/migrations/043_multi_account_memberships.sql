-- 043_multi_account_memberships.sql
-- Rukiye Zara CRM divergence: convert WACRM's single-membership account model
-- into many-to-many account memberships while preserving profiles.account_id /
-- profiles.account_role as the ACTIVE ACCOUNT compatibility layer.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. MEMBERSHIP TABLE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_members (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.account_role_enum NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_members_user
  ON public.account_members(user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_account_members_account_role
  ON public.account_members(account_id, role);

-- Each account still has exactly one owner. accounts.owner_user_id remains the
-- denormalised canonical owner pointer for compatibility.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_members_one_owner_per_account
  ON public.account_members(account_id)
  WHERE role = 'owner';

ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON public.account_members;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.account_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A user may now own more than one CRM workspace.
DROP INDEX IF EXISTS public.idx_accounts_one_per_owner;

-- ---------------------------------------------------------------------------
-- 2. BACKFILL CURRENT WACRM MEMBERSHIPS
-- ---------------------------------------------------------------------------
INSERT INTO public.account_members (account_id, user_id, role)
SELECT p.account_id, p.user_id, p.account_role
FROM public.profiles p
WHERE p.account_id IS NOT NULL
  AND p.account_role IS NOT NULL
ON CONFLICT (account_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    updated_at = now();

-- Defensive owner reconciliation from accounts.owner_user_id.
INSERT INTO public.account_members (account_id, user_id, role)
SELECT a.id, a.owner_user_id, 'owner'::public.account_role_enum
FROM public.accounts a
ON CONFLICT (account_id, user_id) DO UPDATE
SET role = 'owner',
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. MEMBERSHIP HELPERS
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role public.account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.account_members am
    WHERE am.user_id = auth.uid()
      AND am.account_id = target_account_id
      AND CASE am.role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >= CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION public.is_account_member(UUID, public.account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_account_member(UUID, public.account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_account_member(UUID, public.account_role_enum)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_account_role(target_account_id UUID)
RETURNS public.account_role_enum
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT am.role
  FROM public.account_members am
  WHERE am.account_id = target_account_id
    AND am.user_id = auth.uid()
  LIMIT 1;
$$;

ALTER FUNCTION public.get_account_role(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_account_role(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_account_role(UUID) TO authenticated, service_role;

-- Switches the compatibility columns on profiles to the selected workspace.
CREATE OR REPLACE FUNCTION public.switch_account(p_account_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role
  FROM public.account_members
  WHERE account_id = p_account_id
    AND user_id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
  SET account_id = p_account_id,
      account_role = v_role
  WHERE user_id = auth.uid();

  RETURN p_account_id;
END;
$$;

ALTER FUNCTION public.switch_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.switch_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.switch_account(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. RLS FOR MEMBERSHIPS + PROFILE VISIBILITY
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS account_members_select ON public.account_members;
CREATE POLICY account_members_select
  ON public.account_members FOR SELECT
  USING (public.is_account_member(account_id));

-- Membership mutations remain RPC-only.

DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select
  ON public.profiles FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1
      FROM public.account_members target_membership
      WHERE target_membership.user_id = profiles.user_id
        AND public.is_account_member(target_membership.account_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 5. NEW SIGNUPS: CREATE PERSONAL WORKSPACE + OWNER MEMBERSHIP
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
    NULLIF(NEW.raw_user_meta_data->>'name', ''),
    split_part(COALESCE(NEW.email, ''), '@', 1),
    'My account'
  );

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (v_full_name, NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  INSERT INTO public.account_members (account_id, user_id, role)
  VALUES (v_account_id, NEW.id, 'owner');

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ---------------------------------------------------------------------------
-- 6. INVITATIONS: ADD MEMBERSHIP; DO NOT MOVE/DELETE EXISTING WORKSPACE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(p_token_hash TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv public.account_invitations%ROWTYPE;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM public.account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed' USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= now() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_members
    WHERE account_id = v_inv.account_id
      AND user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'You are already a member of this account' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.account_members (account_id, user_id, role)
  VALUES (v_inv.account_id, v_caller_id, v_inv.role);

  UPDATE public.account_invitations
  SET accepted_at = now(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Make the newly joined workspace active so the existing WACRM UI continues
  -- to behave exactly as it did after invitation redemption.
  UPDATE public.profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. MEMBER MANAGEMENT RPCs — OPERATE ON CALLER'S ACTIVE WORKSPACE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role public.account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role public.account_role_enum;
  v_target_role public.account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id
  FROM public.profiles WHERE user_id = auth.uid();

  SELECT role INTO v_caller_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = auth.uid();

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' OR p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership for owner changes' USING ERRCODE = '22023';
  END IF;

  UPDATE public.account_members
  SET role = p_new_role, updated_at = now()
  WHERE account_id = v_account_id AND user_id = p_user_id;

  UPDATE public.profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_account_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, public.account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, public.account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, public.account_role_enum) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_account_member(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role public.account_role_enum;
  v_target_role public.account_role_enum;
  v_fallback_account UUID;
  v_fallback_role public.account_role_enum;
  v_name TEXT;
  v_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id
  FROM public.profiles WHERE user_id = auth.uid();

  SELECT role INTO v_caller_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = auth.uid();

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; switch/leave the account or transfer ownership first' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.account_members
  WHERE account_id = v_account_id AND user_id = p_user_id;

  -- Only change the target's active workspace if the removed workspace was active.
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = p_user_id AND account_id = v_account_id
  ) THEN
    SELECT am.account_id, am.role
    INTO v_fallback_account, v_fallback_role
    FROM public.account_members am
    WHERE am.user_id = p_user_id
    ORDER BY (am.role = 'owner') DESC, am.joined_at ASC
    LIMIT 1;

    -- Legacy users may not have a second/personal workspace because pre-043
    -- invitation redemption deleted it. Create one only when necessary.
    IF v_fallback_account IS NULL THEN
      SELECT full_name, email INTO v_name, v_email
      FROM public.profiles WHERE user_id = p_user_id;

      INSERT INTO public.accounts (name, owner_user_id)
      VALUES (COALESCE(NULLIF(v_name, ''), v_email, 'My account'), p_user_id)
      RETURNING id INTO v_fallback_account;

      v_fallback_role := 'owner';
      INSERT INTO public.account_members (account_id, user_id, role)
      VALUES (v_fallback_account, p_user_id, 'owner');
    END IF;

    UPDATE public.profiles
    SET account_id = v_fallback_account,
        account_role = v_fallback_role
    WHERE user_id = p_user_id;
  END IF;

  RETURN v_fallback_account;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.transfer_account_ownership(p_new_owner_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role public.account_role_enum;
  v_target_role public.account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id
  FROM public.profiles WHERE user_id = auth.uid();

  SELECT role INTO v_caller_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = auth.uid();

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership' USING ERRCODE = '42501';
  END IF;
  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = p_new_owner_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  -- Avoid violating the partial unique owner index: demote then promote in the
  -- same transaction/function call.
  UPDATE public.account_members
  SET role = 'admin', updated_at = now()
  WHERE account_id = v_account_id AND user_id = auth.uid();

  UPDATE public.account_members
  SET role = 'owner', updated_at = now()
  WHERE account_id = v_account_id AND user_id = p_new_owner_user_id;

  UPDATE public.accounts
  SET owner_user_id = p_new_owner_user_id
  WHERE id = v_account_id;

  UPDATE public.profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_account_id;
  UPDATE public.profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. VALIDATION / INVARIANT CHECKS
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.profiles p
    LEFT JOIN public.account_members am
      ON am.account_id = p.account_id AND am.user_id = p.user_id
    WHERE am.user_id IS NULL
  ) THEN
    RAISE EXCEPTION '043 validation failed: a profile active account has no matching account_members row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.accounts a
    LEFT JOIN public.account_members am
      ON am.account_id = a.id
     AND am.user_id = a.owner_user_id
     AND am.role = 'owner'
    WHERE am.user_id IS NULL
  ) THEN
    RAISE EXCEPTION '043 validation failed: an account owner has no owner membership';
  END IF;
END $$;

COMMIT;

-- AFTER APPLYING 043:
-- 1. Existing UI continues using profiles.account_id as active workspace.
-- 2. account_members is now the source of truth for authorization.
-- 3. Existing RLS policies calling is_account_member() automatically become
--    multi-account aware.
-- 4. Invitation redemption adds a membership instead of destroying/moving the
--    user's previous workspace.
-- 5. Next application change: add workspace listing + switch_account() UI.
