import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { coexistenceRecords } from './coexistence-webhook';
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
const metadata = {
  display_phone_number: '15551234567',
  phone_number_id: '456',
};
const echo = {
  id: 'wamid.echo',
  from: '15551234567',
  to: '15557654321',
  timestamp: '1739230955',
  type: 'text',
  text: { body: 'Hello' },
};
const capture = async (
  records: unknown[],
  key = 'event',
  waba = '123',
  phone: string | null = '456'
) =>
  sql(
    `SELECT capture_whatsapp_coexistence_event(${q(JSON.stringify([{ waba, phone_id: phone, key, records }]))}::jsonb);`
  );
const drain = () => sql('SELECT process_whatsapp_coexistence_event();');
const history = (progress: number, chunk: number, message = echo) =>
  coexistenceRecords('history', {
    metadata,
    history: [
      {
        metadata: { phase: 2, chunk_order: chunk, progress },
        threads: [{ id: echo.to, messages: [message] }],
      },
    ],
  });
describe.skipIf(process.env.RGCRM_COEXISTENCE_PG_TEST !== '1')(
  'Coexistence actual PostgreSQL migrations',
  () => {
    beforeEach(async () => {
      await assertDisposable();
      await sql(`BEGIN; TRUNCATE whatsapp_coexistence_events,messages,conversations,contacts,whatsapp_signup_attempts,whatsapp_config,profiles,accounts,auth.users CASCADE;
   ${seed}
   INSERT INTO whatsapp_config(id,user_id,account_id,phone_number_id,waba_id,access_token,display_name,status,onboarding_metadata,coexistence_state)
    VALUES(${q(connection)},${q(user)},${q(account)},'456','123','encrypted','Test','connected','{"onboarding_mode":"coexistence","display_phone_number":"15551234567"}',jsonb_build_object('onboarded_at',now())),
    (${q(otherConnection)},${q(otherUser)},${q(otherAccount)},'789','999','encrypted','Other','connected','{"onboarding_mode":"coexistence"}',jsonb_build_object('onboarded_at',now())); COMMIT;`);
    });
    it('imports echoes once through overlapping workers and webhook replays', async () => {
      const rows = coexistenceRecords('smb_message_echoes', {
        metadata,
        message_echoes: [echo],
      });
      await Promise.all([capture(rows), capture(rows)]);
      await Promise.all([drain(), drain()]);
      expect(await sql('SELECT count(*) FROM messages')).toBe('1');
      expect(await sql('SELECT sender_type FROM messages')).toBe('agent');
      expect(await sql('SELECT unread_count FROM conversations')).toBe('0');
    });
    it('reports pending and exhausted imports only for the requested workspace', async () => {
      await capture(history(30, 1));
      await sql('UPDATE whatsapp_coexistence_events SET attempts=10');
      expect(
        await sql(
          `SELECT connection_id,pending,failed FROM whatsapp_coexistence_import_summary(${q(account)})`
        )
      ).toBe(`${connection}|1|1`);
      expect(
        await sql(
          `SELECT connection_id,pending,failed FROM whatsapp_coexistence_import_summary(${q(otherAccount)})`
        )
      ).toBe(`${otherConnection}|0|0`);
      await expect(
        sql(
          `SET ROLE authenticated; SELECT * FROM whatsapp_coexistence_import_summary(${q(account)})`
        )
      ).rejects.toThrow();
    });
    it('rejects phone-less imports and ignores lifecycle events predating the latest onboarding', async () => {
      await expect(
        capture(history(30, 1), 'missing-phone', '123', null)
      ).rejects.toThrow();
      await capture(
        coexistenceRecords(
          'account_update',
          { event: 'ACCOUNT_OFFBOARDED' },
          1739230955
        ),
        'old-offboard',
        '123',
        null
      );
      await drain();
      expect(
        await sql(
          `SELECT status FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('connected');
    });
    it('resolves tenancy from both authorized WABA and phone, ignoring unrelated combinations', async () => {
      const rows = coexistenceRecords('smb_message_echoes', {
        metadata,
        message_echoes: [echo],
      });
      await capture(rows, 'wrong', '999', '456');
      await drain();
      expect(await sql('SELECT count(*) FROM messages')).toBe('0');
      await capture(rows);
      await drain();
      expect(await sql('SELECT account_id FROM conversations')).toBe(account);
      expect(
        await sql(
          `SELECT count(*) FROM contacts WHERE account_id=${q(otherAccount)}`
        )
      ).toBe('0');
      if (fullSchema) {
        await sql(
          `INSERT INTO contacts(account_id,user_id,phone,name) VALUES(${q(otherAccount)},${q(otherUser)},'15550009999','Other');`
        );
        expect(
          await sql(
            `SET ROLE authenticated; SET request.jwt.claim.sub=${q(user)}; SELECT count(*) FROM contacts;`
          )
        ).toBe('1');
        expect(
          await sql(
            `SET ROLE authenticated; SET request.jwt.claim.sub=${q(user)}; SELECT count(*) FROM whatsapp_config WHERE account_id=${q(otherAccount)};`
          )
        ).toBe('0');
      }
    });
    it('ignores ambiguous phone-less lifecycle events and resolves a supplied display number exactly', async () => {
      await sql(
        `UPDATE whatsapp_config SET waba_id='123',account_id=${q(account)},user_id=${q(user)},onboarding_metadata='{"onboarding_mode":"cloud_api","display_phone_number":"15559876543"}' WHERE id=${q(otherConnection)}`
      );
      const time = Math.floor(Date.now() / 1000) + 2;
      await capture(
        coexistenceRecords(
          'account_update',
          { event: 'ACCOUNT_OFFBOARDED' },
          time
        ),
        'ambiguous',
        '123',
        null
      );
      await drain();
      expect(
        await sql(
          "SELECT count(*) FROM whatsapp_config WHERE status='disconnected'"
        )
      ).toBe('0');
      await capture(
        coexistenceRecords(
          'account_update',
          {
            event: 'PARTNER_REMOVED',
            phone_number: metadata.display_phone_number,
          },
          time
        ),
        'specific',
        '123',
        null
      );
      await drain();
      expect(
        await sql(
          `SELECT status FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('disconnected');
      expect(
        await sql(
          `SELECT status FROM whatsapp_config WHERE id=${q(otherConnection)}`
        )
      ).toBe('connected');
    });
    it('captures many chunks in one call and drains a bounded batch while preserving failed receipts', async () => {
      const events = Array.from({ length: 26 }, (_, i) => ({
        waba: '123',
        phone_id: '456',
        key: `bulk-${i}`,
        records: history(20, i, { ...echo, id: `bulk-${i}` }),
      }));
      await sql(
        `SELECT capture_whatsapp_coexistence_event(${q(JSON.stringify(events))}::jsonb); SELECT process_whatsapp_coexistence_event(25)`
      );
      expect(await sql('SELECT count(*) FROM messages')).toBe('25');
      await drain();
      expect(await sql('SELECT count(*) FROM messages')).toBe('26');
      const good = coexistenceRecords('smb_message_echoes', {
        metadata,
        message_echoes: [{ ...echo, id: 'retry' }],
      });
      await capture(
        [...good, { ...good[0], id: 'invalid', at: null }],
        'retry'
      );
      await drain();
      expect(
        await sql("SELECT count(*) FROM messages WHERE message_id='retry'")
      ).toBe('0');
      await sql(
        `UPDATE whatsapp_coexistence_events SET records=${q(JSON.stringify(good))}::jsonb,retry_at=now() WHERE processed_at IS NULL`
      );
      await drain();
      expect(
        await sql("SELECT count(*) FROM messages WHERE message_id='retry'")
      ).toBe('1');
    });
    it('rolls back the entire capture if any chunk is invalid', async () => {
      const events = [
        { waba: '123', phone_id: '456', key: 'good', records: history(20, 1) },
        { waba: '123', phone_id: '456', key: 'bad', records: null },
      ];
      await expect(
        sql(
          `SELECT capture_whatsapp_coexistence_event(${q(JSON.stringify(events))}::jsonb)`
        )
      ).rejects.toThrow();
      expect(
        await sql('SELECT count(*) FROM whatsapp_coexistence_events')
      ).toBe('0');
    });
    it('out-of-order history never regresses progress or newer inbox summaries', async () => {
      await capture(
        history(100, 3, { ...echo, id: 'new', timestamp: '1739231955' }),
        'last'
      );
      await drain();
      await capture(history(40, 1, { ...echo, id: 'old' }), 'first');
      await drain();
      expect(
        await sql(
          `SELECT coexistence_state->'history'->>'progress' FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('100');
      expect(
        await sql(
          'SELECT extract(epoch FROM last_message_at)::bigint FROM conversations'
        )
      ).toBe('1739231955');
      expect(await sql('SELECT count(*) FROM messages')).toBe('2');
    });
    it('records declined history and does not create messages', async () => {
      await capture(
        coexistenceRecords('history', {
          metadata,
          history: [{ errors: [{ code: 2593109 }] }],
        })
      );
      await drain();
      expect(
        await sql(
          `SELECT coexistence_state->'history'->>'state' FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('declined');
      expect(await sql('SELECT count(*) FROM messages')).toBe('0');
      await capture(history(20, 1), 'old-progress');
      await drain();
      expect(
        await sql(
          `SELECT coexistence_state->'history'->>'state' FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('declined');
    });
    it('keeps completed history terminal on late errors and duplicate progress', async () => {
      await capture(history(100, 3), 'complete');
      await drain();
      await capture(
        [{ kind: 'progress', progress: 10, error: true }],
        'late-error'
      );
      await drain();
      await capture(history(10, 1), 'late');
      await capture(history(10, 1), 'late');
      await drain();
      expect(
        await sql(
          `SELECT coexistence_state->'history'->>'state',coexistence_state->'history'->>'progress' FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('complete|100');
    });
    it('records contact receipt without inventing completion or regressing terminal states', async () => {
      const contacts = coexistenceRecords('smb_app_state_sync', {
        metadata,
        state_sync: [
          {
            type: 'contact',
            action: 'add',
            contact: { phone_number: echo.to },
            metadata: { timestamp: '1739230955' },
          },
        ],
      });
      await capture(contacts, 'contacts');
      await drain();
      expect(
        await sql(
          `SELECT coexistence_state->'smb_app_state_sync'->>'state' FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('received');
      await sql(
        `SELECT accept_whatsapp_coexistence_sync(${q(connection)},'smb_app_state_sync','request'); UPDATE whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,'{smb_app_state_sync,state}','"failed"') WHERE id=${q(connection)}`
      );
      await capture(
        [{ ...contacts[0], at: '2025-02-11T02:23:00Z' }],
        'later-contacts'
      );
      await drain();
      expect(
        await sql(
          `SELECT coexistence_state->'smb_app_state_sync'->>'state' FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('failed');
    });
    it('contact additions and removals are ordered tombstones; CRM history is retained', async () => {
      const contact = (action: string, timestamp: string) =>
        coexistenceRecords('smb_app_state_sync', {
          metadata,
          state_sync: [
            {
              type: 'contact',
              action,
              contact: { phone_number: echo.to, full_name: 'Host contact' },
              metadata: { timestamp },
            },
          ],
        });
      await capture(contact('add', '1739230955'), 'add');
      await drain();
      await capture(history(50, 1), 'history');
      await drain();
      await capture(contact('remove', '1739231955'), 'remove');
      await drain();
      await capture(contact('add', '1739230955'), 'late');
      await drain();
      expect(
        await sql(
          `SELECT smb_app_contacts->${q(connection)}->>'removed' FROM contacts`
        )
      ).toBe('true');
      expect(await sql('SELECT count(*) FROM messages')).toBe('1');
    });
    it('media arriving before its placeholder retries and enriches the same message', async () => {
      await capture(
        coexistenceRecords('history', {
          metadata,
          messages: [
            {
              ...echo,
              type: 'image',
              image: { id: '555', mime_type: 'image/jpeg' },
            },
          ],
        }),
        'media'
      );
      await drain();
      expect(
        await sql('SELECT attempts FROM whatsapp_coexistence_events')
      ).toBe('1');
      await capture(
        history(100, 1, { ...echo, type: 'media_placeholder' }),
        'placeholder'
      );
      await drain();
      await sql(
        'UPDATE whatsapp_coexistence_events SET retry_at=now() WHERE processed_at IS NULL'
      );
      await drain();
      expect(await sql('SELECT count(*) FROM messages')).toBe('1');
      expect(await sql('SELECT content_type FROM messages')).toBe('image');
      expect(await sql('SELECT media_url FROM messages')).toContain(
        `whatsapp_config_id=${connection}`
      );
    });
    it('absent old media remains an explicit placeholder', async () => {
      await capture(history(100, 1, { ...echo, type: 'media_placeholder' }));
      await drain();
      expect(await sql('SELECT content_text FROM messages')).toBe(
        '[Historical media unavailable]'
      );
    });
    it('offboarding pauses the connection and dated reconnection resumes it without resetting sync', async () => {
      const eventTime = Math.floor(Date.now() / 1000) + 2;
      await sql(
        `SELECT begin_whatsapp_coexistence_sync(${q(connection)},'history')`
      );
      await capture(
        coexistenceRecords(
          'account_update',
          { event: 'ACCOUNT_OFFBOARDED' },
          eventTime
        ),
        'offboard',
        '123',
        null
      );
      await drain();
      expect(
        await sql(
          `SELECT status FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('disconnected');
      await capture(
        coexistenceRecords(
          'account_update',
          { event: 'ACCOUNT_RECONNECTED' },
          eventTime + 10
        ),
        'reconnect',
        '123',
        null
      );
      await drain();
      await capture(
        coexistenceRecords(
          'account_update',
          { event: 'ACCOUNT_OFFBOARDED' },
          eventTime
        ),
        'late',
        '123',
        null
      );
      await drain();
      expect(
        await sql(
          `SELECT status FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('connected');
      expect(
        await sql(
          `SELECT begin_whatsapp_coexistence_sync(${q(connection)},'history')`
        )
      ).toBe('f');
    });
    it('one-time intents serialize, survive unconfirmed outcomes and preserve terminal webhook state', async () => {
      const calls = await Promise.all([
        sql(
          `SELECT begin_whatsapp_coexistence_sync(${q(connection)},'history')`
        ),
        sql(
          `SELECT begin_whatsapp_coexistence_sync(${q(connection)},'history')`
        ),
      ]);
      expect(calls.sort()).toEqual(['f', 't']);
      await capture(history(100, 1));
      await drain();
      await sql(
        `SELECT accept_whatsapp_coexistence_sync(${q(connection)},'history','request-id')`
      );
      expect(
        await sql(
          `SELECT coexistence_state->'history'->>'state' FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('complete');
    });
    it('expired sync deadlines cannot be extended by retrying', async () => {
      await sql(
        `UPDATE whatsapp_config SET coexistence_state=jsonb_build_object('onboarded_at',now()-interval '25 hours') WHERE id=${q(connection)}`
      );
      expect(
        await sql(
          `SELECT begin_whatsapp_coexistence_sync(${q(connection)},'history')`
        )
      ).toBe('f');
      expect(
        await sql(
          `SELECT coexistence_state->'history'->>'state' FROM whatsapp_config WHERE id=${q(connection)}`
        )
      ).toBe('deadline_expired');
    });
    it('keeps guarded signup functions service-only without redundant activation wrappers', async () => {
      expect(
        await sql(
          "SELECT to_regprocedure('public.mark_whatsapp_cloud_registration(uuid,uuid,text)') IS NULL AND to_regprocedure('public.finish_whatsapp_signup_activation(uuid,uuid,timestamptz,timestamptz)') IS NULL"
        )
      ).toBe('t');
      expect(
        await sql(
          "SELECT has_function_privilege('service_role','public.mark_whatsapp_registration(uuid,uuid,text)','EXECUTE') AND has_function_privilege('service_role','public.finish_whatsapp_signup(uuid,uuid,timestamptz,timestamptz)','EXECUTE') AND NOT has_function_privilege('authenticated','public.mark_whatsapp_registration(uuid,uuid,text)','EXECUTE') AND NOT has_function_privilege('anon','public.finish_whatsapp_signup(uuid,uuid,timestamptz,timestamptz)','EXECUTE')"
        )
      ).toBe('t');
    });
    it('authenticated and anonymous callers cannot read payloads or execute privileged processing', async () => {
      await expect(
        sql('SET ROLE authenticated; SELECT * FROM whatsapp_coexistence_events')
      ).rejects.toThrow();
      await expect(
        sql('SET ROLE anon; SELECT process_whatsapp_coexistence_event()')
      ).rejects.toThrow();
      await expect(
        sql(
          `SET ROLE authenticated; SELECT begin_whatsapp_coexistence_sync(${q(connection)},'history')`
        )
      ).rejects.toThrow();
    });
  }
);

describe.skipIf(process.env.RGCRM_COEXISTENCE_PG_TEST !== '1')(
  'Coexistence signup lease SQL',
  () => {
    const attempt = '00000000-0000-0000-0000-000000000007',
      lease = '00000000-0000-0000-0000-000000000008';
    beforeEach(async () => {
      await assertDisposable();
      await sql(`BEGIN; TRUNCATE whatsapp_coexistence_events,messages,conversations,contacts,whatsapp_signup_attempts,whatsapp_config,profiles,accounts,auth.users CASCADE;
   ${seed}
   INSERT INTO whatsapp_signup_attempts(id,user_id,account_id,onboarding_mode) VALUES(${q(attempt)},${q(user)},${q(account)},'coexistence'); COMMIT;`);
    });
    const claim = () =>
      sql(
        `SELECT id FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(account)},${q(lease)},'hash','{"waba_id":"123"}','coexistence');`
      );
    it('resolves a WABA-only completion under lease, finalizes canonical config and allows exact replay', async () => {
      await claim();
      await sql(`SELECT resolve_whatsapp_signup_phone(${q(attempt)},${q(lease)},'456');
   SELECT reserve_whatsapp_signup(${q(attempt)},${q(lease)},'456','123','encrypted','{"method":"embedded_signup","onboarding_mode":"coexistence"}');
   SELECT finish_whatsapp_signup(${q(attempt)},${q(lease)},now(),now());`);
      expect(await sql('SELECT status FROM whatsapp_config')).toBe('connected');
      expect(
        await sql('SELECT completion_mode FROM whatsapp_signup_attempts')
      ).toBe('coexistence');
      expect(
        await sql(
          "SELECT coexistence_state ? 'onboarded_at' FROM whatsapp_config"
        )
      ).toBe('t');
      expect(await claim()).toBe(attempt);
    });
    it('never downgrades an explicitly selected Coexistence session on FINISH', async () => {
      await sql(
        `SELECT * FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(account)},${q(lease)},'hash','{"waba_id":"123","phone_number_id":"456"}','cloud_api')`
      );
      expect(
        await sql(
          'SELECT onboarding_mode,completion_mode FROM whatsapp_signup_attempts'
        )
      ).toBe('coexistence|coexistence');
      await expect(
        sql(
          `SELECT mark_whatsapp_registration(${q(attempt)},${q(lease)},'pin')`
        )
      ).rejects.toThrow();
    });
    it('rejects cross-tenant claims and expired worker phone resolution', async () => {
      await expect(
        sql(
          `SELECT id FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(otherAccount)},${q(lease)},'hash','{"waba_id":"123"}','coexistence')`
        )
      ).rejects.toThrow();
      await claim();
      await sql(
        `UPDATE whatsapp_signup_attempts SET lease_until=now()-interval '1 second' WHERE id=${q(attempt)}`
      );
      await expect(
        sql(
          `SELECT resolve_whatsapp_signup_phone(${q(attempt)},${q(lease)},'456')`
        )
      ).rejects.toThrow();
    });
    it('rejects changed completion mode and immutable phone selection', async () => {
      await claim();
      await sql(
        `SELECT resolve_whatsapp_signup_phone(${q(attempt)},${q(lease)},'456')`
      );
      await expect(
        sql(
          `SELECT resolve_whatsapp_signup_phone(${q(attempt)},${q(lease)},'789')`
        )
      ).rejects.toThrow();
      await expect(
        sql(
          `SELECT id FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(account)},${q(lease)},'hash','{"waba_id":"123","phone_number_id":"456"}','cloud_api')`
        )
      ).rejects.toThrow();
    });
    it('atomically promotes a phone-number-first signup and preserves original callback replay', async () => {
      await sql(`UPDATE whatsapp_signup_attempts SET onboarding_mode='cloud_api' WHERE id=${q(attempt)};
        SELECT * FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(account)},${q(lease)},'hash','{"waba_id":"123","phone_number_id":"456"}','cloud_api');
        SELECT reserve_whatsapp_signup(${q(attempt)},${q(lease)},'456','123','encrypted','{"method":"embedded_signup","onboarding_mode":"cloud_api"}');
        SELECT mark_whatsapp_signup_coexistence(${q(attempt)},${q(lease)});`);
      expect(
        await sql(
          "SELECT onboarding_mode,completion_mode,pending_metadata->>'onboarding_mode' FROM whatsapp_signup_attempts"
        )
      ).toBe('coexistence|coexistence|coexistence');
      await expect(
        sql(
          `SELECT mark_whatsapp_registration(${q(attempt)},${q(lease)},'pin')`
        )
      ).rejects.toThrow();
      await sql(`SELECT finish_whatsapp_signup(${q(attempt)},${q(lease)},now(),now());
        SELECT * FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(account)},${q(lease)},'hash','{"waba_id":"123","phone_number_id":"456"}','cloud_api');`);
      expect(
        await sql('SELECT completion_mode FROM whatsapp_signup_attempts')
      ).toBe('coexistence');
      await expect(
        sql(
          `SELECT * FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(account)},${q(lease)},'different-hash','{"waba_id":"123","phone_number_id":"456"}','cloud_api')`
        )
      ).rejects.toThrow();
    });
    const stageCloud = async () =>
      sql(`UPDATE whatsapp_signup_attempts SET onboarding_mode='cloud_api' WHERE id=${q(attempt)};
      SELECT * FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(account)},${q(lease)},'hash','{"waba_id":"123","phone_number_id":"456"}','cloud_api');
      SELECT reserve_whatsapp_signup(${q(attempt)},${q(lease)},'456','123','encrypted','{"onboarding_mode":"cloud_api"}');`);
    it('preserves standard registration once-only intent and completion replay', async () => {
      await stageCloud();
      await sql(
        `SELECT mark_whatsapp_registration(${q(attempt)},${q(lease)},'encrypted-pin')`
      );
      await expect(
        sql(
          `SELECT mark_whatsapp_registration(${q(attempt)},${q(lease)},'encrypted-pin')`
        )
      ).rejects.toThrow('must be reconciled');
      await sql(
        `SELECT finish_whatsapp_signup(${q(attempt)},${q(lease)},now(),now()); SELECT finish_whatsapp_signup(${q(attempt)},${q(lease)},now(),now());`
      );
      expect(await sql('SELECT state FROM whatsapp_signup_attempts')).toBe(
        'complete'
      );
    });
    it('preserves discarded ambiguous registration protection in the simplified function', async () => {
      await stageCloud();
      await sql(`INSERT INTO whatsapp_signup_attempts(id,user_id,account_id,context,registration_requested_at,discarded_at)
        SELECT '00000000-0000-0000-0000-000000000009',user_id,account_id,context,now(),now() FROM whatsapp_signup_attempts WHERE id=${q(attempt)}`);
      await expect(
        sql(
          `SELECT mark_whatsapp_registration(${q(attempt)},${q(lease)},'encrypted-pin')`
        )
      ).rejects.toThrow('Discarded registration outcome');
    });
    it('rejects stale activation leases and changed canonical connections', async () => {
      await stageCloud();
      await sql(
        `UPDATE whatsapp_config SET updated_at=updated_at+interval '1 second' WHERE id=(SELECT connection_id FROM whatsapp_signup_attempts WHERE id=${q(attempt)})`
      );
      await expect(
        sql(
          `SELECT finish_whatsapp_signup(${q(attempt)},${q(lease)},now(),now())`
        )
      ).rejects.toThrow('Connection changed');
      await sql(
        `UPDATE whatsapp_signup_attempts SET lease_until=now()-interval '1 second' WHERE id=${q(attempt)}`
      );
      await expect(
        sql(
          `SELECT finish_whatsapp_signup(${q(attempt)},${q(lease)},now(),now())`
        )
      ).rejects.toThrow('Invalid signup session');
    });
    it('refuses mode promotion after registration intent and under a stale lease', async () => {
      await sql(`UPDATE whatsapp_signup_attempts SET onboarding_mode='cloud_api' WHERE id=${q(attempt)}; SELECT * FROM claim_whatsapp_signup(${q(attempt)},${q(user)},${q(account)},${q(lease)},'hash','{"waba_id":"123","phone_number_id":"456"}','cloud_api');
        SELECT reserve_whatsapp_signup(${q(attempt)},${q(lease)},'456','123','encrypted','{"onboarding_mode":"cloud_api"}');
        SELECT mark_whatsapp_registration(${q(attempt)},${q(lease)},'encrypted-pin');`);
      await expect(
        sql(
          `SELECT mark_whatsapp_signup_coexistence(${q(attempt)},${q(lease)})`
        )
      ).rejects.toThrow();
      expect(
        await sql('SELECT completion_mode FROM whatsapp_signup_attempts')
      ).toBe('cloud_api');
      await sql(
        `UPDATE whatsapp_signup_attempts SET lease_until=now()-interval '1 second' WHERE id=${q(attempt)}`
      );
      await expect(
        sql(
          `SELECT mark_whatsapp_signup_coexistence(${q(attempt)},${q(lease)})`
        )
      ).rejects.toThrow();
    });
  }
);
