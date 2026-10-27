-- Minimal disposable schema for the actual migration 87 and atomic outbound function.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('role',coalesce(nullif(current_setting('request.jwt.claim.role',true),''),current_user)) $$;
CREATE TABLE profiles(user_id uuid, account_id uuid, account_role text);
CREATE OR REPLACE FUNCTION public.is_account_member(account uuid,min_role text DEFAULT 'viewer') RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=auth.uid() AND account_id=account AND account_role IN ('agent','admin','owner')) $$;
CREATE TABLE conversations(id uuid PRIMARY KEY,account_id uuid,contact_id uuid,last_message_text text,last_message_at timestamptz,updated_at timestamptz);
CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,sender_type text,content_type text,content_text text,media_url text,template_name text,interactive_payload jsonb,message_id text,status text,reply_to_message_id uuid,UNIQUE(conversation_id,message_id));
CREATE TABLE flow_runs(account_id uuid,contact_id uuid,status text,ended_at timestamptz,end_reason text);
GRANT USAGE ON SCHEMA auth,public TO authenticated,service_role,anon;
COMMENT ON DATABASE rz_inbox_outbound_test IS 'RZ isolated outbound snapshot test';
