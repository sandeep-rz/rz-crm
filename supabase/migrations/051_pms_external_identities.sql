-- 051_pms_external_identities.sql
-- Securely maps an external PMS user identity to a CRM auth user.
-- Never use email alone as the durable cross-system identity.

create table if not exists public.pms_external_identities (
  id uuid primary key default uuid_generate_v4(),
  provider text not null,
  external_user_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  external_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pms_external_identities_provider_not_blank
    check (btrim(provider) <> ''),
  constraint pms_external_identities_external_user_not_blank
    check (btrim(external_user_id) <> ''),
  constraint pms_external_identities_provider_external_user_unique
    unique (provider, external_user_id)
);

create index if not exists idx_pms_external_identities_user
  on public.pms_external_identities(user_id);

drop trigger if exists set_pms_external_identities_updated_at
  on public.pms_external_identities;

create trigger set_pms_external_identities_updated_at
before update on public.pms_external_identities
for each row execute function public.update_updated_at_column();

alter table public.pms_external_identities enable row level security;

-- This is integration plumbing, not end-user editable data.
revoke all on table public.pms_external_identities from anon, authenticated;
grant select, insert, update, delete on table public.pms_external_identities to service_role;
