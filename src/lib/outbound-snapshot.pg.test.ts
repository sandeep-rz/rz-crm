import { execFileSync } from 'node:child_process';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
const sql = (command: string) =>
  execFileSync(
    'psql',
    [
      '-X',
      '-h',
      '/tmp/rz-upstream-pg-socket',
      '-p',
      '55447',
      '-U',
      'postgres',
      '-d',
      'rz_inbox_outbound_test',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      command,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = id(1),
  account = id(2),
  conversation = id(3),
  foreign = id(4),
  contact = id(5);
const snapshot = {
  version: 1,
  templateId: id(7),
  name: 'welcome',
  language: 'en',
  connectionId: id(8),
  header: { type: 'text', text: 'Welcome Taylor' },
  footer: 'Your host',
  buttons: [{ type: 'QUICK_REPLY', text: 'Need help' }],
};
const save = (extra: Record<string, unknown> = {}, target = conversation) =>
  `SELECT public.record_whatsapp_outbound('${account}','${target}','${JSON.stringify({ content_type: 'template', content_text: 'Hello', template_name: 'welcome', message_id: 'wamid.1', template_snapshot: snapshot, ...extra })}'::jsonb,'Hello')`;
const asUser = (query: string) =>
  `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${user}',true); ${query}; COMMIT;`;
describe.skipIf(process.env.RZ_INBOX_PG_TEST !== '1')(
  'outbound snapshot migration on a disposable database',
  () => {
    beforeAll(() =>
      expect(
        sql(
          "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()"
        )
      ).toBe('RZ isolated outbound snapshot test')
    );
    beforeEach(() =>
      sql(
        `TRUNCATE profiles,conversations,messages,flow_runs; INSERT INTO profiles VALUES('${user}','${account}','agent'); INSERT INTO conversations(id,account_id,contact_id) VALUES('${conversation}','${account}','${contact}'),('${foreign}','${foreign}','${foreign}'); INSERT INTO flow_runs(account_id,contact_id,status) VALUES('${account}','${contact}','active')`
      )
    );
    it('atomically stores the full snapshot, conversation preview and agent handoff', () => {
      sql(asUser(save()));
      expect(JSON.parse(sql('SELECT template_snapshot FROM messages'))).toEqual(
        snapshot
      );
      expect(sql('SELECT status FROM flow_runs')).toBe('paused_by_agent');
      expect(
        sql(
          `SELECT last_message_text FROM conversations WHERE id='${conversation}'`
        )
      ).toBe('Hello');
    });
    it('preserves the original snapshot/read status and does not pause a new flow on replay', () => {
      sql(asUser(save()));
      sql(
        "UPDATE messages SET status='read'; UPDATE flow_runs SET status='active'"
      );
      sql(
        asUser(
          save({
            template_snapshot: { ...snapshot, footer: 'Changed catalog' },
          })
        )
      );
      expect(sql('SELECT count(*) FROM messages')).toBe('1');
      expect(
        sql("SELECT status,template_snapshot->>'footer' FROM messages")
      ).toBe('read|Your host');
      expect(sql('SELECT status FROM flow_runs')).toBe('active');
    });
    it('rejects a foreign conversation before writing', () => {
      expect(() => sql(asUser(save({}, foreign)))).toThrow(
        /Conversation not found/
      );
      expect(sql('SELECT count(*) FROM messages')).toBe('0');
    });
    it('retains the agent permission guard', () => {
      sql("UPDATE profiles SET account_role='viewer'");
      expect(() => sql(asUser(save()))).toThrow(/Agent permission required/);
    });
    it('keeps normal text messages compatible and discards template-only metadata', () => {
      sql(asUser(save({ content_type: 'text' })));
      expect(sql('SELECT template_snapshot IS NULL FROM messages')).toBe('t');
    });
    it('accepts an older caller without a snapshot', () => {
      sql(asUser(save({ template_snapshot: null })));
      expect(sql('SELECT template_snapshot IS NULL FROM messages')).toBe('t');
    });
    it('rejects reply context outside the conversation', () => {
      sql(
        `INSERT INTO messages(id,conversation_id,message_id) VALUES('${id(9)}','${foreign}','foreign')`
      );
      expect(() => sql(asUser(save({ reply_to_message_id: id(9) })))).toThrow(
        /Reply does not belong/
      );
    });
    it('does not expose atomic outbound writes to anonymous callers', () => {
      expect(
        sql(
          "SELECT has_function_privilege('anon','record_whatsapp_outbound(uuid,uuid,jsonb,text)','execute'),has_function_privilege('authenticated','record_whatsapp_outbound(uuid,uuid,jsonb,text)','execute')"
        )
      ).toBe('f|t');
    });
  }
);
