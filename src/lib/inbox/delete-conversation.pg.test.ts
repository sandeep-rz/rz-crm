import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Fixed disposable localhost target only; never read application DB credentials.
const sql = (query: string) =>
  execFileSync(
    'psql',
    [
      '-X',
      '-h',
      '/tmp',
      '-p',
      '55439',
      '-d',
      'rz_chat_delete_test',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
const a = 'aaaaaaaa-0000-4000-8000-000000000000',
  other = 'bbbbbbbb-0000-4000-8000-000000000000';
const user = '11111111-0000-4000-8000-000000000000',
  agent = '22222222-0000-4000-8000-000000000000';
const contact = '33333333-0000-4000-8000-000000000000',
  conn = '44444444-0000-4000-8000-000000000000';
const chat = '55555555-0000-4000-8000-000000000000',
  sibling = '66666666-0000-4000-8000-000000000000';
const asAdmin = `SET ROLE authenticated; SET request.jwt.claim.sub='${user}';`;
const remove = `SELECT delete_conversation_permanently('${a}','${chat}')`;
const fixture = `
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TYPE account_role_enum AS ENUM ('viewer','agent','admin','owner');
CREATE TABLE accounts(id uuid PRIMARY KEY);
CREATE TABLE account_members(account_id uuid,user_id uuid,role account_role_enum);
CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,user_id uuid,phone text,name text,phone_normalized text GENERATED ALWAYS AS (phone) STORED,smb_app_contacts jsonb DEFAULT '{}');
CREATE UNIQUE INDEX contact_peer ON contacts(account_id,phone_normalized) WHERE phone_normalized<>'';
CREATE TABLE whatsapp_config(id uuid PRIMARY KEY,account_id uuid,user_id uuid,phone_number_id text,onboarding_metadata jsonb,coexistence_state jsonb,status text,last_registration_error text);
CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,contact_id uuid REFERENCES contacts(id),whatsapp_config_id uuid REFERENCES whatsapp_config(id),user_id uuid,creation_delivery_id bigint,last_message_at timestamptz,last_message_text text);
CREATE UNIQUE INDEX conversation_peer ON conversations(account_id,contact_id,whatsapp_config_id) WHERE whatsapp_config_id IS NOT NULL;
CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,media_url text,sender_type text,content_type text,content_text text,media_type text,message_id text,status text,created_at timestamptz,coexistence_metadata jsonb,interactive_reply_id text,reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,UNIQUE(conversation_id,message_id));
CREATE TABLE message_reactions(id int,conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,message_id uuid REFERENCES messages(id) ON DELETE CASCADE);
CREATE TABLE notifications(id int,conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE);
CREATE TABLE deals(id int,conversation_id uuid REFERENCES conversations(id));
CREATE TABLE flow_runs(id int,conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,last_prompt_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,status text,last_advanced_at timestamptz,ended_at timestamptz,end_reason text,vars jsonb);
CREATE TABLE automation_pending_executions(id int,account_id uuid,context jsonb,status text,last_error text);
CREATE TABLE whatsapp_coexistence_events(id bigint PRIMARY KEY,event_kind text DEFAULT 'coexistence',connection_id uuid,account_id uuid,records jsonb,processed_at timestamptz,retry_at timestamptz DEFAULT now(),attempts int DEFAULT 0,priority int DEFAULT 3,lease_until timestamptz,stages jsonb DEFAULT '{}',payload jsonb,onboarding_epoch text,last_error text);
CREATE TABLE message_templates(id int,payload jsonb);
CREATE TABLE quick_replies(id int,payload jsonb);
CREATE TABLE flow_nodes(id int,config jsonb);
CREATE TABLE automation_steps(id int,step_config jsonb);
CREATE TABLE broadcasts(id int,payload jsonb);
GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role,anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
`;
const seed = `INSERT INTO accounts VALUES('${a}'),('${other}');
INSERT INTO account_members VALUES('${a}','${user}','admin'),('${a}','${agent}','agent');
INSERT INTO contacts(id,account_id,phone) VALUES('${contact}','${a}','15557654321');
INSERT INTO whatsapp_config VALUES('${conn}','${a}','${user}','456','{"onboarding_mode":"coexistence"}','{}', 'connected',NULL);
INSERT INTO conversations(id,account_id,contact_id,whatsapp_config_id) VALUES('${chat}','${a}','${contact}','${conn}'),('${sibling}','${a}','${contact}',NULL);
INSERT INTO messages(id,conversation_id,media_url) VALUES('77777777-0000-4000-8000-000000000000','${chat}','https://local/storage/v1/object/public/chat-media/account-${a}/photo.jpg');
INSERT INTO message_reactions VALUES(1,'${chat}','77777777-0000-4000-8000-000000000000');
INSERT INTO notifications VALUES(1,'${chat}'); INSERT INTO deals VALUES(1,'${chat}');
INSERT INTO flow_runs VALUES(1,'${chat}','77777777-0000-4000-8000-000000000000','active',now()-interval '1 hour',NULL,NULL,'{}');
INSERT INTO automation_pending_executions VALUES(1,'${a}','{"conversation_id":"${chat}"}','pending',NULL),(2,'${a}','{"conversation_id":"${sibling}"}','pending',NULL);`;
describe.skipIf(process.env.RZ_CHAT_DELETE_PG !== '1')(
  'permanent chat deletion database',
  () => {
    beforeAll(() => {
      expect(sql('SELECT current_database()')).toBe('rz_chat_delete_test');
      sql(
        'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;'
      );
      sql(fixture);
      const membership = readFileSync(
        'supabase/migrations/043_multi_account_memberships.sql',
        'utf8'
      );
      sql(
        membership.slice(
          membership.indexOf(
            'CREATE OR REPLACE FUNCTION public.is_account_member('
          ),
          membership.indexOf('ALTER FUNCTION public.is_account_member')
        )
      );
      const runtime = readFileSync(
        'supabase/migrations/79_whatsapp_runtime_hardening.sql',
        'utf8'
      );
      sql(
        runtime.slice(
          runtime.indexOf(
            'CREATE FUNCTION public.process_whatsapp_coexistence_event('
          ),
          runtime.indexOf('CREATE FUNCTION public.maintain_whatsapp_runtime')
        )
      );
      sql(
        readFileSync(
          'supabase/migrations/82_permanent_conversation_delete.sql',
          'utf8'
        )
      );
    });
    beforeEach(() => {
      sql(
        'TRUNCATE accounts,account_members,contacts,whatsapp_config,conversations,messages,message_reactions,notifications,deals,flow_runs,automation_pending_executions,whatsapp_coexistence_events,message_templates,quick_replies,flow_nodes,automation_steps,broadcasts,conversation_deletions CASCADE;'
      );
      sql(seed);
    });
    it('deletes only the chat; retains contact, connection, deals and sibling work', () => {
      sql(asAdmin + remove);
      expect(sql('SELECT count(*) FROM messages')).toBe('0');
      expect(sql('SELECT count(*) FROM message_reactions')).toBe('0');
      expect(sql('SELECT count(*) FROM notifications')).toBe('0');
      expect(sql('SELECT count(*) FROM contacts')).toBe('1');
      expect(sql('SELECT count(*) FROM whatsapp_config')).toBe('1');
      expect(sql('SELECT count(*) FROM conversations')).toBe('1');
      expect(sql('SELECT conversation_id IS NULL FROM deals')).toBe('t');
      expect(sql('SELECT status FROM flow_runs')).toBe('paused_by_agent');
      expect(
        sql(
          "SELECT string_agg(status,',' ORDER BY id) FROM automation_pending_executions"
        )
      ).toBe('failed,pending');
      expect(JSON.parse(sql(asAdmin + remove)).media_urls).toHaveLength(1);
    });
    it('denies agents and direct deletes; hides chats from another account', () => {
      expect(() =>
        sql(
          `SET ROLE authenticated; SET request.jwt.claim.sub='${agent}';` +
            remove
        )
      ).toThrow();
      expect(() =>
        sql(asAdmin + `DELETE FROM conversations WHERE id='${chat}'`)
      ).toThrow();
      sql(`INSERT INTO account_members VALUES('${other}','${user}','admin')`);
      expect(
        sql(
          asAdmin +
            `SELECT delete_conversation_permanently('${other}','${chat}') IS NULL`
        )
      ).toBe('t');
      expect(sql('SELECT count(*) FROM conversations')).toBe('2');
    });
    it('refuses a running reply without any partial deletion', () => {
      sql(
        "UPDATE automation_pending_executions SET status='running' WHERE id=1"
      );
      expect(() => sql(asAdmin + remove)).toThrow(/conversation_busy/);
      expect(sql('SELECT count(*) FROM conversation_deletions')).toBe('0');
      expect(sql('SELECT count(*) FROM messages')).toBe('1');
    });
    it('refuses active webhook leases and recently advancing flows', () => {
      sql(
        `INSERT INTO whatsapp_coexistence_events(id,event_kind,lease_until,payload) VALUES(9,'delivery',now()+interval '1 minute','{"entry":[{"changes":[{"value":{"metadata":{"phone_number_id":"456"}}}]}]}')`
      );
      expect(() => sql(asAdmin + remove)).toThrow(/conversation_busy/);
      sql('DELETE FROM whatsapp_coexistence_events');
      sql('UPDATE flow_runs SET last_advanced_at=now()');
      expect(() => sql(asAdmin + remove)).toThrow(/conversation_busy/);
      expect(sql('SELECT count(*) FROM messages')).toBe('1');
    });
    it('accepts a fresh durable delivery after deletion', () => {
      sql(asAdmin + remove);
      sql(
        `INSERT INTO whatsapp_coexistence_events(id,payload) VALUES(3,'{"entry":[{"changes":[{"value":{"messages":[{"timestamp":"4070908800"}]}}]}]}')`
      );
      sql(
        `INSERT INTO conversations(account_id,contact_id,whatsapp_config_id,creation_delivery_id) VALUES('${a}','${contact}','${conn}',3)`
      );
      expect(sql('SELECT count(*) FROM conversations')).toBe('2');
    });
    it('checks shared JSON references and signed URL aliases', () => {
      sql(asAdmin + remove);
      const path = `account-${a}/photo.jpg`;
      expect(
        sql(`SELECT conversation_media_is_referenced('unused','${path}')`)
      ).toBe('f');
      sql(
        `INSERT INTO flow_nodes VALUES(1,'{"url":"https://local/storage/v1/object/sign/chat-media/${path}?token=x"}')`
      );
      expect(
        sql(`SELECT conversation_media_is_referenced('unused','${path}')`)
      ).toBe('t');
      expect(() =>
        sql(
          `SET ROLE authenticated; SELECT conversation_media_is_referenced('unused','${path}')`
        )
      ).toThrow();
    });
    it('drops old imported history and allows a genuinely new chat', () => {
      sql(asAdmin + remove);
      const capture = (at: string, id: number) =>
        sql(
          `INSERT INTO whatsapp_coexistence_events(id,connection_id,account_id,records) VALUES(${id},'${conn}','${a}','[{"kind":"message","peer":"15557654321","at":"${at}","id":"wamid.${id}","type":"text","text":"hello","outbound":false}]'); SELECT process_whatsapp_coexistence_event(1,3);`
        );
      capture('2020-01-01T00:00:00Z', 1);
      expect(sql('SELECT count(*) FROM conversations')).toBe('1');
      expect(
        sql(
          'SELECT processed_at IS NOT NULL FROM whatsapp_coexistence_events WHERE id=1'
        )
      ).toBe('t');
      capture('2099-01-01T00:00:00Z', 2);
      expect(sql('SELECT count(*) FROM conversations')).toBe('2');
      expect(sql('SELECT count(*) FROM messages')).toBe('1');
      expect(
        sql(
          `SELECT is_deleted_conversation_message('${a}','${contact}','${conn}',NULL)`
        )
      ).toBe('t');
    });
    it('blocks a stale durable delivery at insert even after a prior cutoff check', () => {
      sql(asAdmin + remove);
      sql(
        `INSERT INTO whatsapp_coexistence_events(id,payload) VALUES(3,'{"entry":[{"changes":[{"value":{"messages":[{"timestamp":"1000"}]}}]}]}')`
      );
      expect(() =>
        sql(
          `INSERT INTO conversations(account_id,contact_id,whatsapp_config_id,creation_delivery_id) VALUES('${a}','${contact}','${conn}',3)`
        )
      ).toThrow(/conversation_deleted/);
    });
  }
);
