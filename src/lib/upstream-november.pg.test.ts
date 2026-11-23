import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
const args = [
  '-X',
  '-h',
  '/tmp/rz-nov23-pg-socket',
  '-p',
  '55449',
  '-U',
  'postgres',
  '-d',
  'rz_november_integrity_test',
  '-v',
  'ON_ERROR_STOP=1',
  '-At',
];
const sql = (s: string) =>
  execFileSync('psql', [...args, '-c', s], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const asyncSql = async (s: string) =>
  (await promisify(execFile)('psql', [...args, '-c', s])).stdout.trim();
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [
  A,
  B,
  OWNER,
  ADMIN,
  AGENT,
  VIEWER,
  OUTSIDER,
  FLOW,
  CONNECTION,
  DOC,
  BROADCAST,
] = Array.from({ length: 11 }, (_, i) => id(i + 1));
const user = (who: string, s: string) =>
  `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${who}',false); ${s};`;
const docChunks = (content: string) =>
  JSON.stringify([{ chunk_index: 0, content, embedding: null }]);
const replace = (content: string, chunks = docChunks(content)) =>
  `SELECT replace_ai_knowledge_chunks('${A}','${DOC}','${content}','${chunks}'::jsonb)`;
describe.skipIf(process.env.RZ_NOVEMBER_PG_TEST !== '1')(
  'November ports on isolated PostgreSQL',
  () => {
    beforeAll(() =>
      expect(
        sql(
          "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()"
        )
      ).toBe('RZ isolated November migration test')
    );
    beforeEach(() => {
      sql(`TRUNCATE profiles,account_members,accounts,conversations,contacts,notifications,flows,flow_nodes,flow_runs,whatsapp_config,broadcasts,ai_knowledge_documents,ai_knowledge_chunks,storage.objects CASCADE;
  INSERT INTO accounts(id,name,owner_user_id) VALUES('${A}','A','${OWNER}'),('${B}','B','${OUTSIDER}');
  INSERT INTO profiles(user_id,account_id,account_role) VALUES('${OWNER}','${A}','owner'),('${ADMIN}','${B}','viewer'),('${AGENT}','${A}','agent'),('${VIEWER}','${A}','viewer'),('${OUTSIDER}','${B}','owner');
  INSERT INTO account_members(account_id,user_id,role) VALUES('${A}','${OWNER}','owner'),('${A}','${ADMIN}','admin'),('${A}','${AGENT}','agent'),('${A}','${VIEWER}','viewer'),('${B}','${ADMIN}','viewer'),('${B}','${OUTSIDER}','owner');
  INSERT INTO whatsapp_config(id,account_id) VALUES('${CONNECTION}','${A}');
  INSERT INTO flows(id,account_id,name,entry_node_id,whatsapp_config_id) VALUES('${FLOW}','${A}','Old','old','${CONNECTION}');
  INSERT INTO flow_nodes(flow_id,node_key,node_type,config) VALUES('${FLOW}','old','end','{}');
  INSERT INTO broadcasts(id,account_id,status) VALUES('${BROADCAST}','${A}','sending');
  INSERT INTO ai_knowledge_documents VALUES('${DOC}','${A}','new');
  INSERT INTO ai_knowledge_chunks(document_id,account_id,chunk_index,content) VALUES('${DOC}','${A}',0,'old');`);
    });
    it('blocks direct profile INSERT and direct privilege UPDATE', () => {
      expect(() =>
        sql(
          user(
            id(90),
            `INSERT INTO profiles(user_id,account_id,account_role) VALUES('${id(90)}','${A}','owner')`
          )
        )
      ).toThrow();
      expect(() =>
        sql(
          user(
            ADMIN,
            `UPDATE profiles SET account_role='owner' WHERE user_id='${ADMIN}'`
          )
        )
      ).toThrow();
    });
    it('preserves trusted workspace switching and ordinary profile editing', () => {
      sql(
        `UPDATE profiles SET account_id='${A}',account_role='admin' WHERE user_id='${ADMIN}'`
      );
      sql(
        user(
          ADMIN,
          `UPDATE profiles SET full_name='Name' WHERE user_id='${ADMIN}'`
        )
      );
      expect(
        sql(
          `SELECT account_id,full_name FROM profiles WHERE user_id='${ADMIN}'`
        )
      ).toBe(`${A}|Name`);
    });
    for (const bucket of ['chat-media', 'flow-media']) {
      it(`denies viewer and foreign ${bucket} writes`, () => {
        expect(() =>
          sql(
            user(
              VIEWER,
              `INSERT INTO storage.objects(bucket_id,name) VALUES('${bucket}','account-${A}/file')`
            )
          )
        ).toThrow();
        expect(() =>
          sql(
            user(
              AGENT,
              `INSERT INTO storage.objects(bucket_id,name) VALUES('${bucket}','account-${B}/file')`
            )
          )
        ).toThrow();
      });
      it(`allows ${bucket} membership writes while another workspace is selected, including replace and delete`, () => {
        sql(
          user(
            ADMIN,
            `INSERT INTO storage.objects(bucket_id,name) VALUES('${bucket}','account-${A}/file'); UPDATE storage.objects SET name='account-${A}/replaced' WHERE bucket_id='${bucket}'`
          )
        );
        expect(sql(`SELECT name FROM storage.objects`)).toBe(
          `account-${A}/replaced`
        );
        expect(() =>
          sql(
            user(ADMIN, `UPDATE storage.objects SET name='account-${B}/stolen'`)
          )
        ).toThrow();
        sql(
          user(ADMIN, `DELETE FROM storage.objects WHERE bucket_id='${bucket}'`)
        );
        expect(sql('SELECT count(*) FROM storage.objects')).toBe('0');
      });
    }
    it('keeps historical flow uploads for operational members but denies viewers', () => {
      sql(
        user(
          AGENT,
          `INSERT INTO storage.objects(bucket_id,name) VALUES('flow-media','${AGENT}/file')`
        )
      );
      expect(() =>
        sql(
          user(
            VIEWER,
            `INSERT INTO storage.objects(bucket_id,name) VALUES('flow-media','${VIEWER}/file')`
          )
        )
      ).toThrow();
    });
    it('accepts a member assigned while switched away, rejects a foreign assignee, and clears removal', () => {
      sql(
        `INSERT INTO conversations(id,account_id,assigned_agent_id) VALUES('${id(40)}','${A}','${ADMIN}'); UPDATE conversations SET assigned_agent_id='${OUTSIDER}' WHERE id='${id(40)}'`
      );
      expect(sql('SELECT assigned_agent_id FROM conversations')).toBe(ADMIN);
      expect(sql('SELECT count(*) FROM notifications')).toBe('1');
      sql(
        `DELETE FROM account_members WHERE account_id='${A}' AND user_id='${ADMIN}'`
      );
      expect(sql('SELECT assigned_agent_id IS NULL FROM conversations')).toBe(
        't'
      );
    });
    it('saves flow metadata and graph atomically, cancelling removed current nodes', () => {
      sql(
        `INSERT INTO flow_runs(flow_id,status,current_node_key) VALUES('${FLOW}','active','old')`
      );
      sql(
        user(
          ADMIN,
          `SELECT replace_flow_graph('${FLOW}','[{"node_key":"new","node_type":"end","config":{}}]','{"name":"New","entry_node_id":"new"}')`
        )
      );
      expect(sql(`SELECT name,entry_node_id FROM flows`)).toBe('New|new');
      expect(sql('SELECT node_key FROM flow_nodes')).toBe('new');
      expect(sql('SELECT status FROM flow_runs')).toBe('cancelled');
    });
    it('rolls back the graph when a node insert fails and rejects foreign connections', () => {
      expect(() =>
        sql(
          user(
            ADMIN,
            `SELECT replace_flow_graph('${FLOW}','[{"node_key":"new","position_x":"bad"}]','{"name":"New"}')`
          )
        )
      ).toThrow();
      expect(sql('SELECT node_key FROM flow_nodes')).toBe('old');
      expect(sql('SELECT name FROM flows')).toBe('Old');
      sql(`INSERT INTO whatsapp_config VALUES('${id(50)}','${B}')`);
      expect(() =>
        sql(
          user(
            ADMIN,
            `SELECT replace_flow_graph('${FLOW}',NULL,'{"whatsapp_config_id":"${id(50)}"}')`
          )
        )
      ).toThrow();
    });
    it('supports metadata-only saves and denies foreign/viewer flow writes', () => {
      sql(
        user(
          ADMIN,
          `SELECT replace_flow_graph('${FLOW}',NULL,'{"name":"New"}')`
        )
      );
      expect(sql('SELECT node_key FROM flow_nodes')).toBe('old');
      for (const who of [VIEWER, OUTSIDER])
        expect(() =>
          sql(
            user(
              who,
              `SELECT replace_flow_graph('${FLOW}',NULL,'{"name":"Denied"}')`
            )
          )
        ).toThrow();
    });
    it('finds expired flows beyond a fresh row cap and honors custom deadlines', () => {
      sql(
        `INSERT INTO flow_runs(flow_id,status,last_advanced_at) SELECT '${FLOW}','active',now() FROM generate_series(1,1100); INSERT INTO flow_runs(id,flow_id,status,last_advanced_at) VALUES('${id(51)}','${FLOW}','active',now()-interval '25 hours')`
      );
      expect(sql(`SELECT id FROM list_timed_out_flow_runs(now(),1)`)).toBe(
        id(51)
      );
      sql('UPDATE flows SET fallback_policy=\'{"on_timeout_hours":48}\'');
      expect(
        sql('SELECT count(*) FROM list_timed_out_flow_runs(now(),10)')
      ).toBe('0');
    });
    it('serializes wizard acquisition and prevents a resume during its live lease', async () => {
      const outcomes = await Promise.all([
        asyncSql(
          user(
            ADMIN,
            `SELECT acquire_broadcast_delivery_lease('${BROADCAST}') IS NOT NULL`
          )
        ),
        asyncSql(
          user(
            AGENT,
            `SELECT acquire_broadcast_delivery_lease('${BROADCAST}') IS NOT NULL`
          )
        ),
      ]);
      expect(outcomes.filter((s) => s.split('\n').includes('t'))).toHaveLength(
        1
      );
      sql(
        `UPDATE broadcasts SET delivery_locked_at=now() WHERE id='${BROADCAST}' AND (delivery_lease_until IS NULL OR delivery_lease_until<now())`
      );
      expect(sql(`SELECT delivery_locked_at IS NULL FROM broadcasts`)).toBe(
        't'
      );
    });
    it('cannot renew an expired or superseded lease and cannot release another holder', () => {
      const lease = sql(
        user(ADMIN, `SELECT acquire_broadcast_delivery_lease('${BROADCAST}')`)
      );
      sql(
        user(
          ADMIN,
          `SELECT release_broadcast_delivery_lease('${BROADCAST}',now()-interval '1 hour')`
        )
      );
      expect(
        sql('SELECT delivery_lease_until IS NOT NULL FROM broadcasts')
      ).toBe('t');
      sql(
        `UPDATE broadcasts SET delivery_lease_until=now()-interval '1 second'`
      );
      expect(
        sql(
          user(
            ADMIN,
            `SELECT renew_broadcast_delivery_lease('${BROADCAST}','${lease}') IS NULL`
          )
        )
      ).toContain('t');
      expect(
        sql(
          user(
            VIEWER,
            `SELECT acquire_broadcast_delivery_lease('${BROADCAST}') IS NULL`
          )
        )
      ).toContain('t');
    });
    it('replaces knowledge atomically, preserves it on insert failure, and rejects stale input', () => {
      sql(replace('new'));
      expect(sql('SELECT content FROM ai_knowledge_chunks')).toBe('new');
      expect(() =>
        sql(replace('new', '[{"chunk_index":0,"content":null}]'))
      ).toThrow();
      expect(sql('SELECT content FROM ai_knowledge_chunks')).toBe('new');
      expect(() => sql(replace('stale'))).toThrow();
    });
    it('serializes concurrent knowledge replacements without duplicate chunks', async () => {
      await Promise.all([asyncSql(replace('new')), asyncSql(replace('new'))]);
      expect(sql('SELECT count(*),min(content) FROM ai_knowledge_chunks')).toBe(
        '1|new'
      );
    });
    it('keeps internal RPCs service-only and rejects foreign document replacement', () => {
      expect(
        sql(
          "SELECT has_function_privilege('authenticated','replace_ai_knowledge_chunks(uuid,uuid,text,jsonb)','execute'),has_function_privilege('authenticated','list_timed_out_flow_runs(timestamptz,integer)','execute'),has_function_privilege('anon','replace_flow_graph(uuid,jsonb,jsonb)','execute')"
        )
      ).toBe('f|f|f');
      expect(() =>
        sql(`SELECT replace_ai_knowledge_chunks('${B}','${DOC}','new','[]')`)
      ).toThrow();
    });
  }
);
