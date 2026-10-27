-- Disposable RLS fixture for migrations 87/88. Never run on a shared database.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('role',coalesce(nullif(current_setting('request.jwt.claim.role',true),''),current_user)) $$;
CREATE TYPE public.account_role_enum AS ENUM ('owner','admin','agent','viewer');
CREATE TABLE accounts(id uuid PRIMARY KEY,default_timezone text NOT NULL DEFAULT 'UTC');
CREATE TABLE account_members(account_id uuid,user_id uuid,role public.account_role_enum);
CREATE TABLE profiles(user_id uuid, account_id uuid, account_role text);
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
CREATE TABLE conversations(id uuid PRIMARY KEY,account_id uuid,contact_id uuid,last_message_text text,last_message_at timestamptz,updated_at timestamptz);
CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,sender_type text,content_type text,content_text text,media_url text,template_name text,interactive_payload jsonb,message_id text,status text,reply_to_message_id uuid,UNIQUE(conversation_id,message_id));
ALTER TABLE messages ADD COLUMN sender_id uuid, ADD COLUMN ai_generated boolean NOT NULL DEFAULT false, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN coexistence_metadata jsonb;
CREATE TABLE flow_runs(account_id uuid,contact_id uuid,status text,ended_at timestamptz,end_reason text);
GRANT USAGE ON SCHEMA auth,public TO authenticated,service_role,anon;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select ON profiles FOR SELECT TO authenticated USING(user_id=auth.uid());
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select ON accounts FOR SELECT TO authenticated USING(public.is_account_member(id));
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_select ON conversations FOR SELECT TO authenticated USING(public.is_account_member(account_id));
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_select ON messages FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.is_account_member(c.account_id)));
GRANT SELECT ON profiles,accounts,conversations,messages TO authenticated;
COMMENT ON DATABASE rz_response_metrics_test IS 'RZ isolated response metrics test';
