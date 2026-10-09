-- Minimal current-schema fixture. Applied only in a newly created local test DB.
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE public.accounts(id uuid PRIMARY KEY);
CREATE TABLE public.profiles(user_id uuid,account_id uuid,account_role text);
CREATE TABLE public.whatsapp_config (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,account_id uuid,phone_number_id text UNIQUE,waba_id text,
 access_token text,display_name text,status text,is_primary boolean DEFAULT false,connected_at timestamptz,
 registered_at timestamptz,subscribed_apps_at timestamptz,last_registration_error text,updated_at timestamptz DEFAULT now(),
 UNIQUE(id,account_id)
);
CREATE TABLE public.contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,user_id uuid,phone text NOT NULL,name text,
 phone_normalized text GENERATED ALWAYS AS (regexp_replace(phone,'\D','','g')) STORED);
CREATE UNIQUE INDEX ON public.contacts(account_id,phone_normalized) WHERE phone_normalized<>'';
CREATE TABLE public.conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,user_id uuid,contact_id uuid,whatsapp_config_id uuid,
 last_message_at timestamptz,last_message_text text,unread_count integer DEFAULT 0,status text DEFAULT 'open');
CREATE UNIQUE INDEX ON public.conversations(account_id,contact_id,whatsapp_config_id) WHERE whatsapp_config_id IS NOT NULL;
CREATE TABLE public.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES public.conversations(id),sender_type text CHECK(sender_type IN ('customer','agent','bot')),
 content_type text CHECK(content_type IN ('text','image','audio','video','document','location','interactive','template')),content_text text,media_type text,media_url text,message_id text,status text CHECK(status IN ('sending','sent','delivered','read','failed')),created_at timestamptz,UNIQUE(conversation_id,message_id));
-- pg_cron isn't shipped by Homebrew PostgreSQL. Record the real schedule call;
-- runtime scheduler execution remains a deployed Supabase check.
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY,jobname text,schedule text,command text);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid $$;
