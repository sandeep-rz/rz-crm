-- 044_create_workspace_rpc.sql
-- Independent CRM: secure workspace creation.
-- Depends on 043_multi_account_memberships.sql.
--
-- accounts             = CRM workspaces / customers
-- account_members      = source of truth for memberships
-- profiles.account_id  = active workspace compatibility pointer
-- profiles.account_role= active workspace role compatibility pointer

begin;

create or replace function public.create_workspace(workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(workspace_name);
  v_account_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  if v_name is null or v_name = '' then
    raise exception 'Workspace name is required'
      using errcode = '22023';
  end if;

  if char_length(v_name) > 100 then
    raise exception 'Workspace name must be 100 characters or fewer'
      using errcode = '22023';
  end if;

  -- The profile should already exist through the normal WACRM signup flow.
  -- Fail rather than silently creating an incomplete profile.
  if not exists (
    select 1
    from public.profiles
    where id = v_user_id
  ) then
    raise exception 'Profile not found'
      using errcode = 'P0001';
  end if;

  insert into public.accounts (name)
  values (v_name)
  returning id into v_account_id;

  insert into public.account_members (
    account_id,
    user_id,
    role
  )
  values (
    v_account_id,
    v_user_id,
    'owner'
  );

  -- Make the newly-created workspace active while preserving the
  -- compatibility model introduced in migration 043.
  update public.profiles
  set
    account_id = v_account_id,
    account_role = 'owner'
  where id = v_user_id;

  return v_account_id;
end;
$$;

revoke all on function public.create_workspace(text) from public;
revoke all on function public.create_workspace(text) from anon;
grant execute on function public.create_workspace(text) to authenticated;

comment on function public.create_workspace(text) is
  'Creates a CRM workspace, adds the authenticated user as owner, and makes it their active workspace. account_members is the membership source of truth; profiles.account_id/account_role remain the active-workspace compatibility fields.';

commit;
