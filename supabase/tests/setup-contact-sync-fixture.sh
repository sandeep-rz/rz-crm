#!/bin/bash
set -euo pipefail
# Disposable local test database only. No remote URL or project credentials.
: "${RZ_CONTACT_PG_SOCKET:?Set the disposable PMS fixture socket first}"
[[ "$RZ_CONTACT_PG_SOCKET" =~ ^/(private/)?tmp/rz-[A-Za-z0-9_.-]+$ ]] || { echo 'Refusing non-test socket'; exit 1; }
contact_test_psql="${RZ_CONTACT_PSQL:-/opt/homebrew/opt/postgresql@14/bin/psql}"
export PATH="$(dirname "$contact_test_psql"):$PATH"
export PGHOST="$RZ_CONTACT_PG_SOCKET" PGPORT=55452 PGUSER=postgres
[[ "$(psql -XqAt -v ON_ERROR_STOP=1 -d rz_contact_v3_test -c 'SELECT count(*) FROM private.contact_fixture_marker')" == 1 ]] || exit 1
cd "$(dirname "$0")/../.."
if [[ "$(psql -XqAt -d postgres -c "SELECT count(*) FROM pg_database WHERE datname='crmtest'")" == 1 ]]; then
  [[ "$(psql -XqAt -v ON_ERROR_STOP=1 -d crmtest -c 'SELECT count(*) FROM public.test_contact_sync_fixture_marker')" == 1 ]] || { echo 'Refusing to reset unmarked database'; exit 1; }
fi
dropdb --if-exists crmtest
createdb crmtest
export PGDATABASE=crmtest
psql -Xqv ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb, created_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE SCHEMA extensions;
CREATE PUBLICATION supabase_realtime;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY, bucket_id text, name text, owner uuid);
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array($1, '/') $$;
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets(name text, decrypted_secret text);
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint, jobname text);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
SQL
for n in 001 002 003 004 005 006 007 008 009 010 011 012 013 014 015 016 017 018 019 020 021 022 023 024 025 026 027 028 029 040 043 044 045 046 048 049 051 052 053 54 55 56 57 58 59 60 61 62 63 71 72 20261110150615; do
  file=$(ls supabase/migrations/${n}_*.sql)
  echo "$file"
  sed -E -e 's/ON DELETE SET NULL \([a-z_, ]+\)/ON DELETE NO ACTION/g' -e '/^CREATE EXTENSION IF NOT EXISTS (supabase_vault|pg_net|pg_cron)/d' "$file" | psql -Xqv ON_ERROR_STOP=1
done

psql -Xqv ON_ERROR_STOP=1 -c 'CREATE TABLE public.test_contact_sync_fixture_marker(id boolean); INSERT INTO public.test_contact_sync_fixture_marker VALUES(true);'
