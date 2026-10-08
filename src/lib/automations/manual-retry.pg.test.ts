import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
// Explicit isolated local PostgreSQL harness; never use a CRM/PMS connection string.
const execute = promisify(execFile);
const sql = async (query: string) =>
  (
    await execute('/opt/homebrew/opt/postgresql@14/bin/psql', [
      '-X',
      '-h',
      '/tmp',
      '-p',
      '55439',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-qAt',
      '-c',
      query,
    ])
  ).stdout.trim();
const account = '11111111-1111-4111-8111-111111111111';
const auto = '22222222-2222-4222-8222-222222222222';
const reservation = '33333333-3333-4333-8333-333333333333';
const job = '44444444-4444-4444-8444-444444444444';
const log = '55555555-5555-4555-8555-555555555555';
const contact = '66666666-6666-4666-8666-666666666666';
const foreign = '77777777-7777-4777-8777-777777777777';
const version = '2026-10-07T00:00:00Z';
const retry = (who = account) =>
  sql(`SELECT public.retry_pms_automation_execution('${log}','${who}');`);
describe.skipIf(process.env.RGCRM_MANUAL_RETRY_PG_TEST !== '1')(
  'actual PostgreSQL manual retry and execution history',
  () => {
    beforeEach(async () => {
      // Presence of this test-only stub is mandatory before destructive fixture reset.
      expect(
        await sql(
          "SELECT to_regclass('public.test_worker_wakeups') IS NOT NULL;"
        )
      ).toBe('t');
      await sql(`TRUNCATE public.automation_pending_executions,public.test_worker_wakeups,public.automation_logs,public.automation_trigger_jobs,public.automations,public.pms_reservations,public.contacts;
     INSERT INTO public.automations(id,account_id,user_id,trigger_type,is_active) VALUES('${auto}','${account}','${contact}','reservation_confirmed',true);
     INSERT INTO public.pms_reservations(id,account_id) VALUES('${reservation}','${account}');
     INSERT INTO public.contacts VALUES('${contact}','${account}');
     INSERT INTO public.automation_trigger_jobs(id,account_id,automation_id,pms_reservation_id,trigger_type,occurrence_key) VALUES('${job}','${account}','${auto}','${reservation}','reservation_confirmed','same-occurrence');
     INSERT INTO public.automation_logs(id,account_id,automation_id,user_id,contact_id,trigger_job_id) VALUES('${log}','${account}','${auto}','${contact}','${contact}','${job}');`);
    });
    it('re-arms a failed non-automatically-retryable job without resetting attempts or clearing historical error', async () => {
      await sql(
        `UPDATE public.automation_trigger_jobs SET attempt_count=5; UPDATE public.automation_logs SET trigger_job_attempt_count=5;`
      );
      expect(await retry()).toBe('queued');
      expect(
        await sql(
          `SELECT status || ':' || attempt_count || ':' || retryable || ':' || last_error FROM public.automation_trigger_jobs;`
        )
      ).toBe('scheduled:5:false:Meta 132018');
      expect(
        await sql(
          `SELECT next_attempt_at IS NULL AND processing_started_at IS NULL AND completed_at IS NULL FROM public.automation_trigger_jobs;`
        )
      ).toBe('t');
      expect(
        await sql(`SELECT count(*) FROM public.test_worker_wakeups;`)
      ).toBe('1');
      expect(
        await sql(`SELECT count(*) FROM public.automation_trigger_jobs;`)
      ).toBe('1');
    });
    it('claims the rearmed job through the existing claim RPC even beyond the automatic attempt limit', async () => {
      await sql(
        `UPDATE public.automation_trigger_jobs SET attempt_count=5; UPDATE public.automation_logs SET trigger_job_attempt_count=5;`
      );
      expect(await retry()).toBe('queued');
      expect(
        await sql(
          `SELECT attempt_count FROM public.claim_automation_trigger_jobs(10,now()-interval '15 minutes',now());`
        )
      ).toBe('6');
    });
    it.each([
      'completed',
      'processing',
      'scheduled',
      'cancelled',
      'suppressed',
    ])('rejects %s jobs', async (status) => {
      await sql(
        `UPDATE public.automation_trigger_jobs SET status='${status}';`
      );
      expect(await retry()).toBe(
        status === 'completed'
          ? 'already_completed'
          : ['processing', 'scheduled'].includes(status)
            ? 'already_retried'
            : 'not_failed'
      );
      expect(
        await sql('SELECT count(*) FROM public.test_worker_wakeups;')
      ).toBe('0');
    });
    it('does not reveal or mutate another account job', async () => {
      expect(await retry(foreign)).toBe('not_found');
      expect(
        await sql('SELECT status FROM public.automation_trigger_jobs;')
      ).toBe('failed');
    });
    it('serializes concurrent Retry requests to one requeue and one wake-up', async () => {
      // Hold the same row lock briefly so both requests overlap at the real PostgreSQL lock boundary.
      const hold = sql(
        `BEGIN; SELECT id FROM public.automation_trigger_jobs FOR UPDATE; SELECT pg_sleep(0.3); COMMIT;`
      );
      const results = await Promise.all([retry(), retry(), hold]);
      expect(results.slice(0, 2).sort()).toEqual(['already_retried', 'queued']);
      expect(
        await sql('SELECT count(*) FROM public.test_worker_wakeups;')
      ).toBe('1');
    });
    it('preserves the old failed record while a new worker claim acquires another log', async () => {
      const original = await sql(
        `SELECT row_to_json(l)::text FROM public.automation_logs l WHERE id='${log}';`
      );
      expect(await retry()).toBe('queued');
      await sql(
        `SELECT * FROM public.claim_automation_trigger_jobs(10,now()-interval '15 minutes',now());`
      );
      expect(
        await sql(
          `SELECT disposition FROM public.begin_pms_automation_execution('${job}',2,'${contact}','${version}');`
        )
      ).toBe('started');
      expect(
        await sql(
          `SELECT row_to_json(l)::text FROM public.automation_logs l WHERE id='${log}';`
        )
      ).toBe(original);
      expect(await sql('SELECT count(*) FROM public.automation_logs;')).toBe(
        '2'
      );
      expect(
        await sql(
          `SELECT disposition FROM public.begin_pms_automation_execution('${job}',2,'${contact}','${version}');`
        )
      ).toBe('already_running');
      expect(await sql('SELECT count(*) FROM public.automation_logs;')).toBe(
        '2'
      );
    });
    it('rejects a completed execution even when job persistence still says failed', async () => {
      await sql(
        `UPDATE public.automation_logs SET trigger_job_execution_state='completed',status='success';`
      );
      expect(await retry()).toBe('already_completed');
      expect(
        await sql('SELECT count(*) FROM public.test_worker_wakeups;')
      ).toBe('0');
    });
    it('the gate refuses replay after a previous attempt completed', async () => {
      await sql(
        `UPDATE public.automation_logs SET trigger_job_execution_state='completed',status='success'; UPDATE public.automation_trigger_jobs SET status='processing',attempt_count=2;`
      );
      expect(
        await sql(
          `SELECT disposition FROM public.begin_pms_automation_execution('${job}',2,'${contact}','${version}');`
        )
      ).toBe('already_completed');
      expect(await sql('SELECT count(*) FROM public.automation_logs;')).toBe(
        '1'
      );
    });
    it('keeps the reservation-version race guard', async () => {
      await retry();
      await sql(
        `SELECT * FROM public.claim_automation_trigger_jobs(10,now()-interval '15 minutes',now());`
      );
      expect(
        await sql(
          `SELECT disposition FROM public.begin_pms_automation_execution('${job}',2,'${contact}','2026-10-06T00:00:00Z');`
        )
      ).toBe('reservation_changed');
      expect(await sql('SELECT count(*) FROM public.automation_logs;')).toBe(
        '1'
      );
    });
    it('manual retry allows changed reservation and automation snapshots', async () => {
      await sql(
        `UPDATE public.pms_reservations SET updated_at='2026-10-08T00:00:00Z'; UPDATE public.automations SET updated_at='2026-10-08T00:00:00Z';`
      );
      expect(await retry()).toBe('queued');
    });
    it.each(['inactive', 'trigger'])(
      'leaves current automation validation to the worker: %s',
      async (kind) => {
        await sql(
          `UPDATE public.automations SET ${kind === 'inactive' ? 'is_active=false' : "trigger_type='reservation_updated'"};`
        );
        expect(await retry()).toBe('queued');
        await sql(
          `SELECT * FROM public.claim_automation_trigger_jobs(10,now()-interval '15 minutes',now());`
        );
        expect(
          await sql(
            `SELECT disposition FROM public.begin_pms_automation_execution('${job}',2,'${contact}','${version}');`
          )
        ).toBe('ineligible');
      }
    );
    it('rejects old attempt rows instead of retrying a newer failure', async () => {
      await sql(`UPDATE public.automation_trigger_jobs SET attempt_count=2;`);
      expect(await retry()).toBe('unsafe_to_retry');
    });
    it.each([
      'meta_sent_message_persistence_failed',
      'sent to Meta but DB insert failed: x',
      'template_send_failed',
    ])(
      'does not reconstruct historical safety from error text: %s',
      async (error) => {
        await sql(
          `UPDATE public.automation_logs SET error_message='${error}';`
        );
        expect(await retry()).toBe('queued');
      }
    );
    it('blocks replay after an earlier successful action', async () => {
      await sql(
        `UPDATE public.automation_logs SET steps_executed='[{"step_type":"send_template","status":"success","detail":"sent meta-id"},{"step_type":"send_template","status":"failed"}]';`
      );
      expect(await retry()).toBe('unsafe_to_retry');
    });
    it('allows a successful condition followed by failed provider rejection', async () => {
      await sql(
        `UPDATE public.automation_logs SET steps_executed='[{"step_type":"condition","status":"success"},{"step_type":"send_template","status":"failed"}]';`
      );
      expect(await retry()).toBe('queued');
    });
    it('unknown processing execution outcome blocks manual replay', async () => {
      await sql(
        `UPDATE public.automation_logs SET trigger_job_execution_state='processing';`
      );
      expect(await retry()).toBe('unsafe_to_retry');
    });
    it('the three-argument rolling-deployment overload retains attempt history', async () => {
      await retry();
      await sql(
        `SELECT * FROM public.claim_automation_trigger_jobs(10,now()-interval '15 minutes',now());`
      );
      expect(
        await sql(
          `SELECT disposition FROM public.begin_pms_automation_execution('${job}',2,'${contact}');`
        )
      ).toBe('started');
      expect(await sql('SELECT count(*) FROM public.automation_logs;')).toBe(
        '2'
      );
    });
    it.each([
      ['failed', 'failed', 'eligible', 'queued'],
      ['completed', 'failed', 'already_completed', 'already_completed'],
      ['scheduled', 'failed', 'already_retried', 'already_retried'],
      ['processing', 'failed', 'already_retried', 'already_retried'],
      ['suppressed', 'failed', 'not_eligible', 'not_failed'],
      ['failed', 'processing', 'not_eligible', 'unsafe_to_retry'],
      ['failed', 'completed', 'already_completed', 'already_completed'],
    ])(
      'bulk eligibility agrees with authoritative retry: %s/%s',
      async (status, state, advisory, result) => {
        await sql(
          `UPDATE public.automation_trigger_jobs SET status='${status}'; UPDATE public.automation_logs SET trigger_job_execution_state='${state}';`
        );
        expect(
          await sql(
            `SELECT retry_state FROM public.get_pms_automation_retry_states('${account}',ARRAY['${log}'::uuid]);`
          )
        ).toBe(advisory);
        expect(await retry()).toBe(result);
      }
    );
    it('enforces one completed execution per occurrence and one log per attempt', async () => {
      await sql(
        `UPDATE public.automation_logs SET trigger_job_execution_state='completed';`
      );
      await expect(
        sql(
          `INSERT INTO public.automation_logs(account_id,automation_id,user_id,trigger_job_id,trigger_job_attempt_count,trigger_job_execution_state) VALUES('${account}','${auto}','${contact}','${job}',2,'completed');`
        )
      ).rejects.toThrow();
      await expect(
        sql(
          `INSERT INTO public.automation_logs(account_id,automation_id,user_id,trigger_job_id,trigger_job_attempt_count) VALUES('${account}','${auto}','${contact}','${job}',1);`
        )
      ).rejects.toThrow();
    });

    it.each([
      'send_template',
      'send_message',
      'send_buttons',
      'send_list',
      'send_webhook',
      'create_deal',
    ])(
      'blocks manual retry and new execution acquisition after successful %s',
      async (type) => {
        await sql(
          `UPDATE public.automation_logs SET steps_executed='[{"step_type":"${type}","status":"success"}]';`
        );
        expect(await retry()).toBe('unsafe_to_retry');
        expect(
          await sql(
            `SELECT retry_state FROM public.get_pms_automation_retry_states('${account}',ARRAY['${log}'::uuid]);`
          )
        ).toBe('unsafe_to_retry');
        await sql(
          `UPDATE public.automation_trigger_jobs SET status='processing',attempt_count=2;`
        );
        expect(
          await sql(
            `SELECT disposition FROM public.begin_pms_automation_execution('${job}',2,'${contact}','${version}');`
          )
        ).toBe('unsafe_to_retry');
        expect(await sql('SELECT count(*) FROM public.automation_logs;')).toBe(
          '1'
        );
      }
    );
    it.each(['external_action', 'whatsapp_unknown', 'whatsapp_accepted'])(
      'blocks manual retry for durable %s evidence even without buffered step results',
      async (reason) => {
        await sql(
          `UPDATE public.automation_logs SET retry_safety='{"reason":"${reason}","step_id":"${contact}","provider_message_id":"accepted-wamid"}';`
        );
        expect(await retry()).toBe('unsafe_to_retry');
      }
    );
    it('records acceptance durably and never clears it as a pre-send failure', async () => {
      await sql(
        `UPDATE public.automation_trigger_jobs SET status='processing';`
      );
      const record = (value: string) =>
        sql(
          `SELECT public.record_automation_retry_safety('${log}','${account}','${contact}',${value});`
        );
      expect(
        await record(
          `'{"reason":"whatsapp_unknown","step_id":"${contact}"}'::jsonb`
        )
      ).toBe('t');
      expect(
        await record(
          `'{"reason":"whatsapp_accepted","step_id":"${contact}","provider_message_id":"accepted-wamid"}'::jsonb`
        )
      ).toBe('t');
      expect(await record('NULL')).toBe('t');
      expect(
        await sql(
          `SELECT retry_safety->>'provider_message_id' FROM public.automation_logs;`
        )
      ).toBe('accepted-wamid');
      await sql(`UPDATE public.automation_trigger_jobs SET status='failed';`);
      expect(await retry()).toBe('unsafe_to_retry');
    });
    it('clears only the current pre-Meta guard and keeps preparation failures eligible', async () => {
      await sql(
        `UPDATE public.automation_trigger_jobs SET status='processing';`
      );
      await sql(
        `SELECT public.record_automation_retry_safety('${log}','${account}','${contact}','{"reason":"whatsapp_unknown","step_id":"${contact}"}');`
      );
      await sql(
        `SELECT public.record_automation_retry_safety('${log}','${account}','${contact}',NULL); UPDATE public.automation_trigger_jobs SET status='failed';`
      );
      expect(await retry()).toBe('queued');
    });

    it('does not block explicit assignment from step type alone', async () => {
      await sql(
        `UPDATE public.automation_logs SET steps_executed='[{"step_type":"assign_conversation","status":"success"}]';`
      );
      expect(await retry()).toBe('queued');
    });
    it.each(['external_action', 'whatsapp_accepted'])(
      'preserves earlier %s across a different step clear/acceptance',
      async (reason) => {
        await sql(`UPDATE public.automation_trigger_jobs SET status='processing';
          UPDATE public.automation_logs SET retry_safety='{"reason":"${reason}","step_id":"${contact}"}';`);
        for (const safety of [
          `'{"reason":"whatsapp_unknown","step_id":"${foreign}"}'::jsonb`,
          'NULL',
          `'{"reason":"whatsapp_accepted","step_id":"${foreign}","provider_message_id":"later"}'::jsonb`,
        ])
          await sql(
            `SELECT public.record_automation_retry_safety('${log}','${account}','${foreign}',${safety});`
          );
        expect(
          await sql(
            `SELECT retry_safety->>'reason' || ':' || (retry_safety->>'step_id') FROM public.automation_logs;`
          )
        ).toBe(`${reason}:${contact}`);
        await sql(`UPDATE public.automation_trigger_jobs SET status='failed';`);
        expect(await retry()).toBe('unsafe_to_retry');
      }
    );

    it('keeps continuation safety local while preserving the pre-Wait whole-execution guard', async () => {
      await sql(`UPDATE public.automation_trigger_jobs SET status='completed';
        UPDATE public.automation_logs SET retry_safety='{"reason":"whatsapp_accepted","step_id":"${contact}","provider_message_id":"before-wait"}';
        INSERT INTO public.automation_pending_executions(id,automation_id,account_id,log_id,context,status,attempt_count)
          VALUES('${reservation}','${auto}','${account}','${log}','{"vars":{"preserved":true}}','running',1);`);
      // The pre-Wait send does not contaminate this new segment's state.
      expect(
        await sql(
          `SELECT context ? '__retry_safety' FROM public.automation_pending_executions;`
        )
      ).toBe('f');
      const record = (value: string, attempt = 1, who = account) =>
        sql(
          `SELECT public.record_automation_retry_safety('${log}','${who}','${foreign}',${value},'${reservation}',${attempt});`
        );
      expect(
        await record(`'{"reason":"whatsapp_unknown","step_id":"${foreign}"}'`)
      ).toBe('t');
      expect(await record('NULL')).toBe('t');
      expect(
        await sql(
          `SELECT context ? '__retry_safety' FROM public.automation_pending_executions;`
        )
      ).toBe('f');
      expect(
        await sql(
          `SELECT retry_safety->>'provider_message_id' FROM public.automation_logs;`
        )
      ).toBe('before-wait');
      expect(
        await record(`'{"reason":"whatsapp_unknown","step_id":"${foreign}"}'`)
      ).toBe('t');
      expect(
        await record(
          `'{"reason":"whatsapp_accepted","step_id":"${foreign}","provider_message_id":"inside-wait"}'`
        )
      ).toBe('t');
      expect(await record('NULL')).toBe('t');
      expect(
        await sql(
          `SELECT context->'__retry_safety'->>'provider_message_id' FROM public.automation_pending_executions;`
        )
      ).toBe('inside-wait');
      expect(
        await sql(
          `SELECT context->'vars'->>'preserved' FROM public.automation_pending_executions;`
        )
      ).toBe('true');
      expect(await record('NULL', 2)).toBe('f');
      expect(await record('NULL', 1, foreign)).toBe('f');
      expect(
        await sql(
          `SELECT retry_safety->>'provider_message_id' FROM public.automation_logs;`
        )
      ).toBe('before-wait');
    });
    it('preserves an in-segment external action across a later step pre-Meta failure', async () => {
      await sql(`UPDATE public.automation_trigger_jobs SET status='processing';
        INSERT INTO public.automation_pending_executions(id,automation_id,account_id,log_id,context,status,attempt_count)
          VALUES('${reservation}','${auto}','${account}','${log}','{}','running',1);
        SELECT public.record_automation_retry_safety('${log}','${account}','${contact}','{"reason":"external_action","step_id":"${contact}"}','${reservation}',1);
        SELECT public.record_automation_retry_safety('${log}','${account}','${foreign}','{"reason":"whatsapp_unknown","step_id":"${foreign}"}','${reservation}',1);
        SELECT public.record_automation_retry_safety('${log}','${account}','${foreign}',NULL,'${reservation}',1);`);
      expect(
        await sql(
          `SELECT context->'__retry_safety'->>'reason' FROM public.automation_pending_executions;`
        )
      ).toBe('external_action');
      await sql(`UPDATE public.automation_trigger_jobs SET status='failed';`);
      expect(await retry()).toBe('unsafe_to_retry');
    });

    it.each(['processing', 'completed'])(
      'root guard permits processing but fences completed PMS jobs: %s',
      async (status) => {
        await sql(
          `UPDATE public.automation_trigger_jobs SET status='${status}';`
        );
        expect(
          await sql(
            `SELECT public.record_automation_retry_safety('${log}','${account}','${contact}','{"reason":"external_action","step_id":"${contact}"}');`
          )
        ).toBe(status === 'processing' ? 't' : 'f');
        expect(
          await sql(
            `SELECT retry_safety IS NOT NULL FROM public.automation_logs;`
          )
        ).toBe(status === 'processing' ? 't' : 'f');
      }
    );
    it.each([
      ['wrong attempt', reservation, account, log, auto, 'running', 2],
      ['wrong pending id', foreign, account, log, auto, 'running', 1],
      ['wrong account', reservation, foreign, log, auto, 'running', 1],
      ['wrong log', reservation, account, foreign, auto, 'running', 1],
      ['wrong automation', reservation, account, log, foreign, 'running', 1],
      ['not running', reservation, account, log, auto, 'done', 1],
    ] as const)(
      'rejects %s continuation before recording safety',
      async (
        _label,
        pendingId,
        pendingAccount,
        pendingLog,
        pendingAuto,
        status,
        attempt
      ) => {
        await sql(`UPDATE public.automation_trigger_jobs SET status='completed';
        INSERT INTO public.automation_pending_executions(id,automation_id,account_id,log_id,context,status,attempt_count)
          VALUES('${reservation}','${pendingAuto}','${pendingAccount}','${pendingLog}','{}','${status}',1);`);
        expect(
          await sql(
            `SELECT public.record_automation_retry_safety('${log}','${account}','${contact}','{"reason":"external_action","step_id":"${contact}"}','${pendingId}',${attempt});`
          )
        ).toBe('f');
        expect(
          await sql(`SELECT retry_safety IS NULL FROM public.automation_logs;`)
        ).toBe('t');
        expect(
          await sql(
            `SELECT context ? '__retry_safety' FROM public.automation_pending_executions;`
          )
        ).toBe('f');
      }
    );
    it('fences stale claims and refuses foreign-account safety writes', async () => {
      await sql(
        `UPDATE public.automation_trigger_jobs SET status='processing',attempt_count=2;`
      );
      expect(
        await sql(
          `SELECT public.record_automation_retry_safety('${log}','${account}','${contact}','{"reason":"external_action","step_id":"${contact}"}');`
        )
      ).toBe('f');
      expect(
        await sql(
          `SELECT public.record_automation_retry_safety('${log}','${foreign}','${contact}',NULL);`
        )
      ).toBe('f');
    });
    it('database retry functions are not executable by browser roles', async () => {
      for (const role of ['anon', 'authenticated'])
        for (const signature of [
          'retry_pms_automation_execution(uuid,uuid)',
          'automation_retry_block_reason(uuid,uuid)',
          'record_automation_retry_safety(uuid,uuid,uuid,jsonb,uuid,integer)',
        ])
          expect(
            await sql(
              `SELECT has_function_privilege('${role}','public.${signature}','EXECUTE');`
            )
          ).toBe('f');
    });
  }
);
