-- 045_invited_signup_and_workspace_permissions.sql
-- Rukiye Zara CRM
--
-- Depends on:
--   043_multi_account_memberships.sql
--   044_create_workspace_rpc.sql
--
-- Goals:
-- 1. Normal signup still receives an automatic owner workspace.
-- 2. A NEW user signing up from a valid team invitation receives only a
--    profile initially; no throwaway/personal workspace is created.
-- 3. redeem_invitation() remains responsible for adding the invited
--    membership and making that workspace active.
-- 4. Additional workspace creation is allowed only when the caller:
--      a) already owns at least one workspace, OR
--      b) has zero memberships (recovery/first-workspace path).
--    A user who belongs only as admin/agent/viewer cannot create another
--    workspace.
--
-- The signup UI must send:
--   raw_user_meta_data.crm_invite_token_hash = SHA-256(invite token), hex
-- only when signup originated from /signup?invite=<token>.
--
-- The trigger does NOT trust the marker by itself. It validates that the
-- hash belongs to a currently pending, unexpired invitation.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ALLOW A PROFILE TO EXIST BRIEFLY WITHOUT AN ACTIVE WORKSPACE
-- ---------------------------------------------------------------------------
-- This is required for a brand-new invited team member:
-- auth.users -> profile (unlinked) -> email verification -> redeem invite
-- -> account_members membership -> active profile account/role.
ALTER TABLE public.profiles
  ALTER COLUMN account_id DROP NOT NULL,
  ALTER COLUMN account_role DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. SIGNUP BOOTSTRAP
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
  v_invite_hash TEXT;
  v_has_valid_invite BOOLEAN := FALSE;
BEGIN
  v_full_name := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
    NULLIF(NEW.raw_user_meta_data->>'name', ''),
    split_part(COALESCE(NEW.email, ''), '@', 1),
    'My account'
  );

  v_invite_hash := NULLIF(
    btrim(COALESCE(NEW.raw_user_meta_data->>'crm_invite_token_hash', '')),
    ''
  );

  -- Never trust "invited" metadata by itself. Only suppress automatic
  -- workspace creation when the supplied SHA-256 hash matches a real,
  -- pending and unexpired invitation.
  IF v_invite_hash IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.account_invitations ai
      WHERE ai.token_hash = v_invite_hash
        AND ai.accepted_at IS NULL
        AND ai.expires_at > now()
    )
    INTO v_has_valid_invite;
  END IF;

  IF v_has_valid_invite THEN
    -- Invited team member: create identity/profile only.
    -- redeem_invitation() will create account_members and set these active
    -- workspace compatibility fields after authentication.
    INSERT INTO public.profiles (
      user_id,
      full_name,
      email,
      account_id,
      account_role
    )
    VALUES (
      NEW.id,
      v_full_name,
      NEW.email,
      NULL,
      NULL
    );

    RETURN NEW;
  END IF;

  -- Normal standalone signup: preserve existing WACRM/RZR behavior.
  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (v_full_name, NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (
    user_id,
    full_name,
    email,
    account_id,
    account_role
  )
  VALUES (
    NEW.id,
    v_full_name,
    NEW.email,
    v_account_id,
    'owner'
  );

  INSERT INTO public.account_members (account_id, user_id, role)
  VALUES (v_account_id, NEW.id, 'owner');

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ---------------------------------------------------------------------------
-- 3. HARDEN WORKSPACE CREATION
-- ---------------------------------------------------------------------------
-- Policy:
--   - unauthenticated -> denied
--   - zero memberships -> allowed (recovery / first workspace)
--   - owns >= 1 workspace -> allowed
--   - memberships exist but none are owner -> denied
--
-- This prevents a caretaker/agent/admin who only belongs to another
-- business from creating additional CRM workspaces, while still allowing
-- legitimate business owners to operate multiple businesses.
CREATE OR REPLACE FUNCTION public.create_workspace(workspace_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_name TEXT := btrim(workspace_name);
  v_account_id UUID;
  v_membership_count INTEGER;
  v_owns_workspace BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  IF v_name IS NULL OR v_name = '' THEN
    RAISE EXCEPTION 'Workspace name is required'
      USING ERRCODE = '22023';
  END IF;

  IF char_length(v_name) > 100 THEN
    RAISE EXCEPTION 'Workspace name must be 100 characters or fewer'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
  INTO v_membership_count
  FROM public.account_members
  WHERE user_id = v_user_id;

  SELECT EXISTS (
    SELECT 1
    FROM public.account_members
    WHERE user_id = v_user_id
      AND role = 'owner'
  )
  INTO v_owns_workspace;

  IF v_membership_count > 0 AND NOT v_owns_workspace THEN
    RAISE EXCEPTION 'Only workspace owners can create additional workspaces'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (v_name, v_user_id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.account_members (
    account_id,
    user_id,
    role
  )
  VALUES (
    v_account_id,
    v_user_id,
    'owner'
  );

  UPDATE public.profiles
  SET
    account_id = v_account_id,
    account_role = 'owner'
  WHERE user_id = v_user_id;

  RETURN v_account_id;
END;
$$;

ALTER FUNCTION public.create_workspace(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_workspace(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_workspace(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_workspace(TEXT) TO authenticated;

COMMENT ON FUNCTION public.create_workspace(TEXT) IS
  'Creates a CRM workspace for an authenticated user who owns a workspace or has no memberships. Team-only admin/agent/viewer users cannot create additional workspaces.';

COMMIT;
