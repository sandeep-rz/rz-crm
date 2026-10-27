import { execFileSync } from 'node:child_process';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ResponseTimeSummary } from './types';
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
      'rz_response_metrics_test',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-f',
      '-',
    ],
    { input: command, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = id(1),
  account = id(2),
  conversation = id(3),
  foreign = id(4),
  contact = id(5);
const asUser = (query: string, who = user, role = 'authenticated') =>
  `BEGIN; SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claim.sub','${who}',true),set_config('request.jwt.claim.role','${role}',true); ${query}; COMMIT;`;
const query = (command: string, who = user, role = 'authenticated') =>
  sql(asUser(command, who, role))
    .split('\n')
    .filter((line) => line !== 'COMMIT')
    .at(-1)!;
const metrics = (target = account) =>
  JSON.parse(
    query(`SELECT public.dashboard_response_metrics('${target}')`)
  ) as ResponseTimeSummary;
let previousWeek: number, currentWeek: number;
const at = (minutes: number, base = previousWeek) =>
  new Date(base + minutes * 60_000).toISOString();
function message(
  n: number,
  sender: string,
  minutes: number,
  extra: Record<string, unknown> = {},
  conv = conversation
) {
  const data = {
    id: id(n),
    conversation_id: conv,
    sender_type: sender,
    created_at: at(minutes),
    status: 'sent',
    ai_generated: false,
    ...(sender === 'agent' ? { sender_id: user } : {}),
    ...extra,
  };
  sql(
    `INSERT INTO messages SELECT * FROM jsonb_populate_record(NULL::messages,'${JSON.stringify(data)}'::jsonb)`
  );
}
describe.skipIf(process.env.RZ_METRICS_PG_TEST !== '1')(
  'response metrics and actor attribution with actual migrations/RLS',
  () => {
    beforeAll(() => {
      expect(
        sql(
          "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()"
        )
      ).toBe('RZ isolated response metrics test');
      currentWeek = new Date(
        sql(
          "SELECT date_trunc('week',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
        )
      ).getTime();
      previousWeek = currentWeek - 7 * 86400_000;
    });
    beforeEach(() =>
      sql(
        `TRUNCATE profiles,account_members,accounts,conversations,messages,flow_runs; INSERT INTO accounts(id) VALUES('${account}'),('${foreign}'); INSERT INTO profiles VALUES('${user}','${account}','agent'); INSERT INTO account_members VALUES('${account}','${user}','agent'); INSERT INTO conversations(id,account_id,contact_id) VALUES('${conversation}','${account}','${contact}'),('${foreign}','${foreign}','${foreign}');`
      )
    );
    it('measures the human at 15 minutes separately from AI at 2 minutes, ignoring bot/failed sends', () => {
      message(10, 'customer', 60);
      message(11, 'bot', 61);
      message(12, 'agent', 61.5, { status: 'failed' });
      message(13, 'bot', 62, { ai_generated: true });
      message(14, 'agent', 75);
      const result = metrics();
      expect(result.human.lastWeekAvg).toBe(15);
      expect(result.ai.lastWeekAvg).toBe(2);
      expect(result.human.buckets[0].samples).toBe(1);
    });
    it('does not count a second customer in one burst or reuse replies for a later turn', () => {
      message(10, 'customer', 60);
      message(11, 'customer', 62);
      message(12, 'agent', 70);
      message(13, 'customer', 90);
      message(14, 'bot', 91, { ai_generated: true });
      message(15, 'agent', 95);
      const result = metrics();
      expect(result.human.buckets[0].samples).toBe(2);
      expect(result.human.lastWeekAvg).toBe(7.5);
      expect(result.ai.lastWeekAvg).toBe(1);
    });
    it('excludes imported history, app echoes, unattributed API sends and revoked/placeholder messages', () => {
      message(10, 'customer', 10, { coexistence_metadata: { history: true } });
      message(11, 'agent', 11, { coexistence_metadata: { history: true } });
      message(12, 'customer', 60);
      message(13, 'agent', 61, { sender_id: null });
      message(14, 'agent', 62, { coexistence_metadata: { revoked: true } });
      message(15, 'agent', 63, { coexistence_metadata: { placeholder: true } });
      message(16, 'agent', 70);
      expect(metrics().human.lastWeekAvg).toBe(10);
    });
    it('does not invent a new turn when a burst crosses the reporting boundary', () => {
      message(10, 'customer', -10);
      message(11, 'customer', 5);
      message(12, 'agent', 10);
      expect(metrics().human.lastWeekAvg).toBeNull();
    });
    it('ignores failed AI, in-flight messages and future replies; an unanswered turn stays unsampled', () => {
      message(10, 'customer', 60);
      message(11, 'bot', 61, { ai_generated: true, status: 'failed' });
      message(12, 'agent', 62, { status: 'sending' });
      message(13, 'agent', 0, {
        created_at: new Date(Date.now() + 86400_000).toISOString(),
      });
      expect(metrics().human.lastWeekAvg).toBeNull();
      expect(metrics().ai.lastWeekAvg).toBeNull();
    });
    it('uses stable IDs when timestamps tie and accepts a zero-minute real reply', () => {
      message(11, 'agent', 60);
      message(10, 'customer', 60);
      expect(metrics().human.buckets[0]).toEqual({
        dow: 0,
        avgMinutes: 0,
        samples: 1,
      });
    });
    it('uses the saved workspace timezone for weekday and week boundaries', () => {
      sql(
        `UPDATE accounts SET default_timezone='America/New_York' WHERE id='${account}'`
      );
      message(10, 'customer', 10, { created_at: at(10, currentWeek) });
      message(11, 'agent', 20, { created_at: at(20, currentWeek) });
      const result = metrics();
      expect(result.timeZone).toBe('America/New_York');
      expect(result.human.buckets[6].samples).toBe(1);
      expect(result.human.lastWeekAvg).toBe(10);
      expect(result.human.thisWeekAvg).toBeNull();
    });
    it('includes all response samples beyond the REST row cap', () => {
      sql(
        `INSERT INTO conversations(id,account_id) SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${account}' FROM generate_series(1,1200) n; INSERT INTO messages(id,conversation_id,sender_type,status,created_at,sender_id,ai_generated) SELECT gen_random_uuid(),id,sender,'sent',('${at(60)}'::timestamptz + delay),CASE WHEN sender='agent' THEN '${user}'::uuid END,false FROM conversations CROSS JOIN (VALUES('customer',interval '0 min'),('agent',interval '10 min')) v(sender,delay) WHERE account_id='${account}'`
      );
      expect(metrics().human.buckets[0].samples).toBe(1201);
    });
    it('denies another workspace even for a member until it is selected, and never reads foreign rows', () => {
      message(10, 'customer', 60, {}, foreign);
      message(11, 'agent', 65, {}, foreign);
      expect(metrics().human.lastWeekAvg).toBeNull();
      expect(() => metrics(foreign)).toThrow(
        /Current workspace membership required/
      );
      sql(
        `INSERT INTO account_members VALUES('${foreign}','${user}','viewer')`
      );
      expect(() => metrics(foreign)).toThrow(
        /Current workspace membership required/
      );
      sql(
        `UPDATE profiles SET account_id='${foreign}',account_role='viewer' WHERE user_id='${user}'`
      );
      expect(metrics(foreign).human.lastWeekAvg).toBe(5);
      expect(() => metrics()).toThrow(/Current workspace membership required/);
    });
    it('records the authenticated actor, ignores spoofed payload identities and preserves snapshot/replay/handoff', () => {
      sql(
        `INSERT INTO flow_runs VALUES('${account}','${contact}','active',NULL,NULL)`
      );
      const save = (footer = 'Original') =>
        `SELECT record_whatsapp_outbound('${account}','${conversation}','${JSON.stringify({ content_type: 'template', message_id: 'wamid.test', sender_id: foreign, template_snapshot: { footer }, content_text: 'Hello' })}'::jsonb,'Hello')`;
      query(save());
      expect(sql('SELECT sender_id FROM messages')).toBe(user);
      expect(sql('SELECT status FROM flow_runs')).toBe('paused_by_agent');
      sql(
        "UPDATE messages SET status='read'; UPDATE flow_runs SET status='active'"
      );
      query(save('Edited'));
      expect(
        sql(
          "SELECT status,template_snapshot->>'footer',sender_id FROM messages"
        )
      ).toBe(`read|Original|${user}`);
      expect(sql('SELECT status FROM flow_runs')).toBe('active');
    });
    it('does not attribute a service/API send even if JWT sub or payload contains a user', () => {
      query(
        `SELECT record_whatsapp_outbound('${account}','${conversation}','{"content_type":"text","message_id":"api.send","sender_id":"${user}"}'::jsonb,'API')`,
        user,
        'service_role'
      );
      expect(sql('SELECT sender_id IS NULL FROM messages')).toBe('t');
    });
    it('retains sender permissions and denies anonymous metric access', () => {
      sql(
        "UPDATE profiles SET account_role='viewer'; UPDATE account_members SET role='viewer'"
      );
      expect(() =>
        query(
          `SELECT record_whatsapp_outbound('${account}','${conversation}','{"content_type":"text","message_id":"blocked"}'::jsonb,'No')`
        )
      ).toThrow(/Agent permission required/);
      expect(
        sql(
          "SELECT has_function_privilege('anon','dashboard_response_metrics(uuid)','execute'),has_function_privilege('authenticated','dashboard_response_metrics(uuid)','execute'),has_function_privilege('service_role','dashboard_response_metrics(uuid)','execute'),prosecdef FROM pg_proc WHERE oid='dashboard_response_metrics(uuid)'::regprocedure"
        )
      ).toBe('f|t|f|f');
    });
  }
);
