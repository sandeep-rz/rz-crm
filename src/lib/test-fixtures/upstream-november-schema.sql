-- Additional minimal contracts for migration 93. Apply after the upstream
-- integrity fixture and migration 86 in an isolated PostgreSQL database only.
CREATE SCHEMA storage;
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO authenticated,service_role;
GRANT ALL ON storage.objects TO authenticated,service_role;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select ON profiles FOR SELECT TO authenticated USING (user_id=auth.uid());
CREATE POLICY profiles_insert ON profiles FOR INSERT TO authenticated WITH CHECK (user_id=auth.uid());
CREATE POLICY profiles_update ON profiles FOR UPDATE TO authenticated USING (user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
CREATE TABLE contacts(id uuid PRIMARY KEY,name text,phone text);
CREATE TABLE notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,user_id uuid,type text,conversation_id uuid,contact_id uuid,actor_user_id uuid,title text,body text);
ALTER TABLE conversations ADD COLUMN account_id uuid, ADD COLUMN contact_id uuid;
CREATE TABLE whatsapp_config(id uuid PRIMARY KEY,account_id uuid);
ALTER TABLE flows ADD COLUMN name text, ADD COLUMN description text, ADD COLUMN trigger_type text,
 ADD COLUMN trigger_config jsonb, ADD COLUMN entry_node_id text, ADD COLUMN fallback_policy jsonb,
 ADD COLUMN whatsapp_config_id uuid REFERENCES whatsapp_config(id), ADD COLUMN updated_at timestamptz;
ALTER TABLE flow_runs ADD COLUMN last_advanced_at timestamptz DEFAULT now();
ALTER TABLE broadcasts ADD COLUMN delivery_locked_at timestamptz;
CREATE TABLE ai_knowledge_documents(id uuid PRIMARY KEY,account_id uuid,content text);
-- Vector conversion is represented by text in this focused PG14 fixture.
ALTER TABLE ai_knowledge_chunks ADD COLUMN document_id uuid REFERENCES ai_knowledge_documents(id),
 ADD COLUMN chunk_index integer, ADD COLUMN embedding text;
ALTER TABLE ai_knowledge_chunks ALTER COLUMN content SET NOT NULL;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated,service_role;
