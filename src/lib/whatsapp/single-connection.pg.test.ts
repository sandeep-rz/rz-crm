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
  user = '00000000-0000-0000-0000-000000000002',
  connection = '00000000-0000-0000-0000-000000000003';
const otherAccount = '00000000-0000-0000-0000-000000000004',
  otherUser = '00000000-0000-0000-0000-000000000005',
  otherConnection = '00000000-0000-0000-0000-000000000006';
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

const insertConnection = (
  id = connection,
  owner = user,
  workspace = account,
  phone = '456'
) =>
  sql(
    `INSERT INTO whatsapp_config(id,user_id,account_id,phone_number_id,waba_id,access_token,status,is_primary) VALUES(${q(id)},${q(owner)},${q(workspace)},${q(phone)},'123','live-token','connected',true)`
  );
const attempt = '00000000-0000-0000-0000-000000000011',
  lease = '00000000-0000-0000-0000-000000000012';
const clear = (id = attempt) =>
  sql(
    `SELECT clear_unfinished_whatsapp_signup(${q(id)},${q(user)},${q(account)})`
  );
describe.skipIf(process.env.RGCRM_COEXISTENCE_PG_TEST !== '1' || !fullSchema)(
  'single WhatsApp connection and fresh signup policy',
  () => {
    beforeEach(async () => {
      await assertDisposable();
      await sql(
        `BEGIN;TRUNCATE whatsapp_coexistence_events,messages,conversations,contacts,whatsapp_signup_attempts,whatsapp_config,profiles,accounts,auth.users CASCADE;${seed} COMMIT;`
      );
    });
    it('serializes concurrent number creation and keeps one connection per workspace', async () => {
      const outcomes = await Promise.allSettled([
        sql(
          `BEGIN; INSERT INTO whatsapp_config(id,user_id,account_id,phone_number_id,waba_id,access_token,is_primary) VALUES(${q(connection)},${q(user)},${q(account)},'456','123','token',false); SELECT pg_sleep(0.2); COMMIT`
        ),
        sql(
          `BEGIN; INSERT INTO whatsapp_config(id,user_id,account_id,phone_number_id,waba_id,access_token,is_primary) VALUES(${q(otherConnection)},${q(user)},${q(account)},'789','123','token',false); SELECT pg_sleep(0.2); COMMIT`
        ),
      ]);
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(
        await sql(
          `SELECT count(*) FROM whatsapp_config WHERE account_id=${q(account)}`
        )
      ).toBe('1');
      await insertConnection(
        '00000000-0000-0000-0000-000000000013',
        otherUser,
        otherAccount,
        '555'
      );
      expect(await sql('SELECT count(*) FROM whatsapp_config')).toBe('2');
    });
    it('permits existing standard/manual updates and blocks a second connection or transfer into a full workspace', async () => {
      await insertConnection();
      await insertConnection(otherConnection, otherUser, otherAccount, '789');
      await sql(
        `UPDATE whatsapp_config SET display_name='Renamed',access_token='rotated',phone_number_id='457' WHERE id=${q(connection)}`
      );
      await expect(
        sql(
          `UPDATE whatsapp_config SET account_id=${q(account)} WHERE id=${q(otherConnection)}`
        )
      ).rejects.toThrow();
      await expect(
        sql(`SELECT assert_whatsapp_connection_slot(${q(account)})`)
      ).rejects.toThrow();
      await sql(
        `SELECT assert_whatsapp_connection_slot(${q(account)},${q(connection)})`
      );
    });
    it('preserves maintenance of existing multi-number workspaces without allowing another number', async () => {
      await insertConnection();
      await sql(
        `ALTER TABLE whatsapp_config DISABLE TRIGGER enforce_one_whatsapp_connection; INSERT INTO whatsapp_config(id,user_id,account_id,phone_number_id,waba_id,access_token,is_primary) VALUES(${q(otherConnection)},${q(user)},${q(account)},'789','123','legacy-token',false); ALTER TABLE whatsapp_config ENABLE TRIGGER enforce_one_whatsapp_connection;`
      );
      await sql(
        `SELECT assert_whatsapp_connection_slot(${q(account)},${q(connection)}); UPDATE whatsapp_config SET access_token='rotated' WHERE id=${q(connection)}`
      );
      await expect(
        insertConnection(
          '00000000-0000-0000-0000-000000000015',
          user,
          account,
          '777'
        )
      ).rejects.toThrow();
      expect(await sql('SELECT count(*) FROM whatsapp_config')).toBe('2');
    });
    it('removes abandoned authorization and a reserved placeholder so the host can start fresh', async () => {
      await insertConnection();
      await sql(`UPDATE whatsapp_config SET status='disconnected',connected_at=NULL,onboarding_metadata='{"method":"embedded_signup"}' WHERE id=${q(connection)};
   INSERT INTO whatsapp_signup_attempts(id,user_id,account_id,connection_id,authorization_token,pending_access_token) VALUES(${q(attempt)},${q(user)},${q(account)},${q(connection)},'secret-authorization','secret-pending');`);
      await clear();
      await clear();
      expect(await sql('SELECT count(*) FROM whatsapp_signup_attempts')).toBe(
        '0'
      );
      expect(await sql('SELECT count(*) FROM whatsapp_config')).toBe('0');
      await insertConnection();
    });
    it('never deletes or changes a working connection when its reconnect is abandoned', async () => {
      await insertConnection();
      await sql(
        `INSERT INTO whatsapp_signup_attempts(id,user_id,account_id,reconnect_id,connection_id,state,pending_access_token) VALUES(${q(attempt)},${q(user)},${q(account)},${q(connection)},${q(connection)},'failed','replacement-token')`
      );
      await clear();
      expect(await sql('SELECT access_token,status FROM whatsapp_config')).toBe(
        'live-token|connected'
      );
      expect(await sql('SELECT count(*) FROM whatsapp_signup_attempts')).toBe(
        '0'
      );
    });
    it('retains only the uncertain-registration barrier and prevents blind registration on a fresh attempt', async () => {
      const context = '{"waba_id":"123","phone_number_id":"456"}';
      await sql(
        `INSERT INTO whatsapp_signup_attempts(id,user_id,account_id,context,registration_requested_at,pending_access_token,authorization_token,pending_registration_pin) VALUES(${q(attempt)},${q(user)},${q(account)},${q(context)},now(),'secret','authorization','pin')`
      );
      await clear();
      expect(
        await sql(
          'SELECT pending_access_token IS NULL AND authorization_token IS NULL AND pending_registration_pin IS NULL AND discarded_at IS NOT NULL FROM whatsapp_signup_attempts'
        )
      ).toBe('t');
      const fresh = '00000000-0000-0000-0000-000000000014';
      await sql(
        `INSERT INTO whatsapp_signup_attempts(id,user_id,account_id,context,state,lease_id,lease_until,pending_access_token,completion_mode) VALUES(${q(fresh)},${q(user)},${q(account)},${q(context)},'processing',${q(lease)},now()+interval '2 minutes','fresh-token','cloud_api')`
      );
      await expect(
        sql(
          `SELECT mark_whatsapp_registration(${q(fresh)},${q(lease)},'encrypted-pin')`
        )
      ).rejects.toThrow('Previous registration outcome');
    });
    it('does not interrupt active activation and cleans it after the lease expires', async () => {
      await sql(
        `INSERT INTO whatsapp_signup_attempts(id,user_id,account_id,state,lease_id,lease_until,pending_access_token) VALUES(${q(attempt)},${q(user)},${q(account)},'processing',${q(lease)},now()+interval '2 minutes','active-token')`
      );
      await clear();
      expect(
        await sql('SELECT pending_access_token FROM whatsapp_signup_attempts')
      ).toBe('active-token');
      await sql(
        "UPDATE whatsapp_signup_attempts SET lease_until=now()-interval '1 second'"
      );
      await sql('SELECT maintain_whatsapp_runtime()');
      expect(await sql('SELECT count(*) FROM whatsapp_signup_attempts')).toBe(
        '0'
      );
    });
    it('cleans expired sessions through the existing maintenance job and restricts client access', async () => {
      await sql(
        `INSERT INTO whatsapp_signup_attempts(id,user_id,account_id,authorization_token,expires_at) VALUES(${q(attempt)},${q(user)},${q(account)},'expired-secret',now()-interval '1 second'); SELECT maintain_whatsapp_runtime()`
      );
      expect(await sql('SELECT count(*) FROM whatsapp_signup_attempts')).toBe(
        '0'
      );
      await expect(
        sql(
          `SET ROLE authenticated;SELECT clear_unfinished_whatsapp_signup(${q(attempt)},${q(user)},${q(account)})`
        )
      ).rejects.toThrow();
      await expect(
        sql(
          `SELECT clear_unfinished_whatsapp_signup(${q(attempt)},${q(otherUser)},${q(account)})`
        )
      ).rejects.toThrow();
    });
  }
);
