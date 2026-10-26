import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
const execute = promisify(execFile);
// Two fixed disposable targets only; the full-schema target must carry a marker.
// Never use application database credentials or a caller-supplied remote host.
const fullSchema = process.env.RGCRM_COEXISTENCE_FULL_SCHEMA === '1';
const sql = async (query: string) =>
  (
    await execute(
      'psql',
      [
        '-X',
        '-h',
        fullSchema ? '127.0.0.1' : '/tmp',
        '-p',
        fullSchema ? '54325' : '55441',
        ...(fullSchema ? ['-U', 'supabase_admin'] : []),
        '-d',
        fullSchema ? 'postgres' : 'rgcrm_coexistence_test',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        query,
      ],
      {
        env: {
          ...process.env,
          ...(fullSchema ? { PGPASSWORD: 'postgres' } : {}),
        },
      }
    )
  ).stdout.trim();
const q = (v: unknown) => `'${String(v).replaceAll("'", "''")}'`;
const account = '00000000-0000-0000-0000-000000000001',
  user = '00000000-0000-0000-0000-000000000002';
const otherAccount = '00000000-0000-0000-0000-000000000004',
  otherUser = '00000000-0000-0000-0000-000000000005';
const assertDisposable = async () => {
  if (fullSchema) {
    expect(
      await sql(
        "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()"
      )
    ).toBe('RGCRM disposable coexistence full schema');
  } else
    expect(await sql('SELECT current_database()')).toBe(
      'rgcrm_coexistence_test'
    );
};
const seed = fullSchema
  ? `
  ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;
  INSERT INTO auth.users(id,email) VALUES(${q(user)},'one@example.test'),(${q(otherUser)},'two@example.test');
  INSERT INTO accounts(id,name,owner_user_id) VALUES(${q(account)},'One',${q(user)}),(${q(otherAccount)},'Two',${q(otherUser)});
  INSERT INTO profiles(user_id,account_id,account_role,full_name,email) VALUES(${q(user)},${q(account)},'owner','One','one@example.test'),(${q(otherUser)},${q(otherAccount)},'owner','Two','two@example.test');
  INSERT INTO account_members(account_id,user_id,role) VALUES(${q(account)},${q(user)},'owner'),(${q(otherAccount)},${q(otherUser)},'owner');
  ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created;
`
  : `
  INSERT INTO accounts VALUES(${q(account)}),(${q(otherAccount)});INSERT INTO auth.users VALUES(${q(user)}),(${q(otherUser)});
  INSERT INTO profiles VALUES(${q(user)},${q(account)},'owner'),(${q(otherUser)},${q(otherAccount)},'owner');
`;

const person = '00000000-0000-0000-0000-000000000021',
  conv = '00000000-0000-0000-0000-000000000022',
  flow = '00000000-0000-0000-0000-000000000023';
const payload = (id = 'wamid.outbound') =>
  JSON.stringify({
    message_id: id,
    content_type: 'text',
    content_text: 'Hello',
  });
const agent = (who = user) =>
  `SET ROLE authenticated; SET request.jwt.claim.sub=${q(who)};`;
const save = (extra = {}, accountId = account, conversationId = conv) =>
  `SELECT record_whatsapp_outbound(${q(accountId)},${q(conversationId)},${q(JSON.stringify({ ...JSON.parse(payload()), ...extra }))},'Hello')`;
describe.skipIf(process.env.RGCRM_COEXISTENCE_PG_TEST !== '1' || !fullSchema)(
  'atomic outbound persistence',
  () => {
    beforeEach(async () => {
      await assertDisposable();
      await sql(`BEGIN;TRUNCATE whatsapp_coexistence_events,messages,conversations,contacts,whatsapp_signup_attempts,whatsapp_config,profiles,accounts,auth.users CASCADE;${seed}
   INSERT INTO contacts(id,account_id,user_id,phone) VALUES(${q(person)},${q(account)},${q(user)},'15551234567');
   INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES(${q(conv)},${q(account)},${q(user)},${q(person)});
   INSERT INTO flows(id,account_id,user_id,name,trigger_type) VALUES(${q(flow)},${q(account)},${q(user)},'Test','manual');
   INSERT INTO flow_runs(flow_id,account_id,user_id,contact_id,conversation_id,status) VALUES(${q(flow)},${q(account)},${q(user)},${q(person)},${q(conv)},'active');COMMIT;`);
    });
    it('commits a message, preview and agent handoff in one authorized transaction', async () => {
      const id = await sql(`${agent()}${save()}`);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        await sql('SELECT content_text,status,sender_type FROM messages')
      ).toBe('Hello|sent|agent');
      expect(await sql('SELECT last_message_text FROM conversations')).toBe(
        'Hello'
      );
      expect(await sql('SELECT status,end_reason FROM flow_runs')).toBe(
        'paused_by_agent|agent_replied'
      );
    });
    it('deduplicates repeated wamids without regressing read state or pausing a newly started flow', async () => {
      const first = await sql(`${agent()}${save()}`);
      await sql(
        "UPDATE messages SET status='read';UPDATE conversations SET last_message_text='Newer message';UPDATE flow_runs SET status='active',ended_at=NULL,end_reason=NULL"
      );
      expect(await sql(`${agent()}${save()}`)).toBe(first);
      expect(await sql('SELECT count(*),min(status) FROM messages')).toBe(
        '1|read'
      );
      expect(await sql('SELECT last_message_text FROM conversations')).toBe(
        'Newer message'
      );
      expect(await sql('SELECT status FROM flow_runs')).toBe('active');
    });
    it('rejects viewers, unauthenticated users and foreign-workspace targets before writes', async () => {
      await sql(
        `UPDATE profiles SET account_role='viewer' WHERE user_id=${q(user)}; UPDATE account_members SET role='viewer' WHERE user_id=${q(user)}`
      );
      await expect(sql(`${agent()}${save()}`)).rejects.toThrow(
        'Agent permission'
      );
      await expect(sql(`SET ROLE anon;${save()}`)).rejects.toThrow();
      await expect(sql(`${agent(otherUser)}${save()}`)).rejects.toThrow();
      await expect(
        sql(`${agent(otherUser)}${save({}, otherAccount)}`)
      ).rejects.toThrow('Conversation not found');
      expect(await sql('SELECT count(*) FROM messages')).toBe('0');
    });
    it('supports service-role public API persistence with an explicit scoped account', async () => {
      await sql(
        `SET ROLE service_role;SET request.jwt.claims='{"role":"service_role"}';${save()}`
      );
      expect(await sql('SELECT count(*) FROM messages')).toBe('1');
      await expect(
        sql(
          `SET ROLE service_role;SET request.jwt.claims='{"role":"service_role"}';${save({ message_id: 'foreign' }, otherAccount)}`
        )
      ).rejects.toThrow();
    });
    it('rejects invalid reply ownership and malformed messages atomically', async () => {
      await expect(
        sql(`${agent()}${save({ reply_to_message_id: flow })}`)
      ).rejects.toThrow('Reply does not belong');
      await expect(
        sql(`${agent()}${save({ content_type: 'unsupported' })}`)
      ).rejects.toThrow('Invalid outbound');
      expect(await sql('SELECT count(*) FROM messages')).toBe('0');
      expect(await sql('SELECT status FROM flow_runs')).toBe('active');
    });
  }
);
