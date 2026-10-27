import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const enabled = process.env.RZ_UPSTREAM_PG_TEST === '1';
const args = [
  '-X',
  '-h',
  '/tmp/rz-upstream-pg-socket',
  '-p',
  '55447',
  '-U',
  'postgres',
  '-d',
  'rz_upstream_integrity_test',
  '-v',
  'ON_ERROR_STOP=1',
  '-At',
];
const sql = (text: string) =>
  execFileSync('psql', [...args, '-c', text], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const U1 = '10000000-0000-4000-8000-000000000001';
const U2 = '20000000-0000-4000-8000-000000000002';
const U3 = '30000000-0000-4000-8000-000000000003';
const U4 = '40000000-0000-4000-8000-000000000004';
const asUser = (user: string, command: string) =>
  `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${user}',true); ${command}; COMMIT;`;

describe.skipIf(!enabled)(
  'selective upstream migration on a disposable database',
  () => {
    beforeAll(() => {
      expect(
        sql(
          "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()"
        )
      ).toBe('RZ isolated upstream migration test');
    });
    beforeEach(() => {
      sql(`TRUNCATE profiles,account_members,accounts,ai_configs,ai_usage_log,ai_knowledge_chunks,conversations,flows,flow_nodes,flow_runs,quick_replies,broadcasts,broadcast_recipients,automation_pending_executions CASCADE;
    INSERT INTO accounts(id,name,owner_user_id) VALUES('${A}','A','${U1}'),('${B}','B','${U4}');
    INSERT INTO profiles(user_id,account_id,account_role) VALUES('${U1}','${A}','owner'),('${U2}','${A}','admin'),('${U3}','${A}','agent'),('${U4}','${B}','owner');
    INSERT INTO account_members(account_id,user_id,role) VALUES('${A}','${U1}','owner'),('${A}','${U2}','admin'),('${A}','${U3}','agent'),('${B}','${U4}','owner'),('${B}','${U2}','viewer');`);
    });
    it('claims an eligible AI reply once and respects the count cap', () => {
      sql(`INSERT INTO conversations(id) VALUES('${U1}')`);
      expect(sql(`SELECT claim_ai_reply_slot('${U1}',1)`)).toBe('t');
      expect(sql(`SELECT claim_ai_reply_slot('${U1}',1)`)).toBe('f');
    });
    it('does not claim an AI slot after pause or human assignment', () => {
      sql(
        `INSERT INTO conversations(id,ai_autoreply_disabled) VALUES('${U1}',true); INSERT INTO conversations(id,assigned_agent_id) VALUES('${U2}','${U3}')`
      );
      expect(sql(`SELECT claim_ai_reply_slot('${U1}',3)`)).toBe('f');
      expect(sql(`SELECT claim_ai_reply_slot('${U2}',3)`)).toBe('f');
      expect(sql('SELECT sum(ai_reply_count) FROM conversations')).toBe('0');
    });
    it('keeps AI slot and broadcast creation RPCs service-only', () => {
      expect(
        sql(
          "SELECT has_function_privilege('authenticated','claim_ai_reply_slot(uuid,integer)','execute'),has_function_privilege('service_role','claim_ai_reply_slot(uuid,integer)','execute'),has_function_privilege('authenticated','create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb)','execute')"
        )
      ).toBe('f|t|f');
    });
    it('requires a base URL only for the compatible AI provider', () => {
      expect(() =>
        sql("INSERT INTO ai_configs(provider) VALUES('openai_compatible')")
      ).toThrow();
      sql(
        "INSERT INTO ai_configs(provider,base_url) VALUES('openai',NULL),('openai_compatible','https://example.com/v1')"
      );
    });
    it('matches any knowledge term while isolating the workspace', () => {
      sql(
        `INSERT INTO ai_knowledge_chunks(account_id,content) VALUES('${A}','pool'),('${A}','parking'),('${B}','pool parking')`
      );
      expect(
        sql(
          `SELECT count(*) FROM match_ai_knowledge_fts('${A}','pool parking',10)`
        )
      ).toBe('2');
      expect(
        sql(`SELECT count(*) FROM match_ai_knowledge_fts('${A}','',10)`)
      ).toBe('0');
    });
    it('preserves variable-length parameter arrays paired to each broadcast recipient', () => {
      sql(
        `SELECT * FROM create_broadcast_with_recipients('${A}','${U1}','test','hello','en',2,ARRAY['${U2}','${U3}']::uuid[],'[["first"],["second","extra"]]'::jsonb)`
      );
      expect(
        sql(
          'SELECT contact_id,template_params FROM broadcast_recipients ORDER BY contact_id'
        )
      ).toBe(`${U2}|["first"]\n${U3}|["second", "extra"]`);
    });
    it('rejects malformed broadcast params without leaving an orphan campaign', () => {
      expect(() =>
        sql(
          `SELECT * FROM create_broadcast_with_recipients('${A}','${U1}','bad','hello','en',2,ARRAY['${U2}','${U3}']::uuid[],'[["one"]]'::jsonb)`
        )
      ).toThrow();
      expect(sql('SELECT count(*) FROM broadcasts')).toBe('0');
    });
    it('validates new quick-reply content against its kind', () => {
      expect(() =>
        sql("INSERT INTO quick_replies(kind,content_text) VALUES('text',' ')")
      ).toThrow();
      sql(
        "INSERT INTO quick_replies(kind,content_text) VALUES('text','Hello')"
      );
    });
    it('cancels runs whose current node was removed by an authorized graph save', () => {
      sql(
        `INSERT INTO flows(id,account_id) VALUES('${U1}','${A}'); INSERT INTO flow_runs(flow_id,status,current_node_key) VALUES('${U1}','active','removed')`
      );
      sql(
        asUser(
          U2,
          `SELECT replace_flow_nodes('${U1}','[{"node_key":"new","node_type":"start"}]')`
        )
      );
      expect(sql('SELECT status,end_reason FROM flow_runs')).toBe(
        'cancelled|current_node_removed'
      );
    });
    it('rejects graph replacement from a foreign workspace', () => {
      sql(`INSERT INTO flows(id,account_id) VALUES('${U1}','${A}')`);
      expect(() =>
        sql(asUser(U4, `SELECT replace_flow_nodes('${U1}','[]')`))
      ).toThrow();
    });
    it('blocks direct ownership/id changes while allowing normal account edits', () => {
      expect(() =>
        sql(
          asUser(
            U2,
            `UPDATE accounts SET owner_user_id='${U2}' WHERE id='${A}'`
          )
        )
      ).toThrow();
      sql(asUser(U2, `UPDATE accounts SET name='Renamed' WHERE id='${A}'`));
      expect(sql(`SELECT name FROM accounts WHERE id='${A}'`)).toBe('Renamed');
    });
    it('refuses member mutations by a caller with no membership', () => {
      sql(
        `DELETE FROM account_members WHERE user_id='${U2}' AND account_id='${A}'`
      );
      expect(() =>
        sql(asUser(U2, `SELECT set_member_role('${U3}','admin')`))
      ).toThrow();
    });
    it('transfers ownership without changing memberships in another workspace', () => {
      sql(asUser(U1, `SELECT transfer_account_ownership('${U2}')`));
      expect(
        sql(
          `SELECT role FROM account_members WHERE account_id='${B}' AND user_id='${U2}'`
        )
      ).toBe('viewer');
      expect(sql(`SELECT owner_user_id FROM accounts WHERE id='${A}'`)).toBe(
        U2
      );
      expect(
        sql(
          `SELECT count(*) FROM account_members WHERE account_id='${A}' AND role='owner'`
        )
      ).toBe('1');
    });
    it('serializes concurrent ownership transfer and member removal', async () => {
      const run = promisify(execFile);
      const transfer = run('psql', [
        ...args,
        '-c',
        asUser(U1, `SELECT transfer_account_ownership('${U2}')`),
      ]);
      const removal = run('psql', [
        ...args,
        '-c',
        asUser(U1, `SELECT remove_account_member('${U2}')`),
      ]);
      const results = await Promise.allSettled([transfer, removal]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expect(
        sql(
          `SELECT count(*) FROM account_members m JOIN accounts a ON a.id=m.account_id AND a.owner_user_id=m.user_id WHERE a.id='${A}' AND m.role='owner'`
        )
      ).toBe('1');
      expect(
        sql(
          `SELECT count(*) FROM account_members WHERE account_id='${B}' AND user_id='${U2}' AND role='viewer'`
        )
      ).toBe('1');
    });
    it('adds a stable wait cursor without introducing another claim/lease field', () => {
      expect(
        sql(
          "SELECT column_name FROM information_schema.columns WHERE table_name='automation_pending_executions' AND column_name IN ('parked_step_id','claimed_at')"
        )
      ).toBe('parked_step_id');
    });
  }
);
