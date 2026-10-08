import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  claimBroadcastRecipient,
  BROADCAST_DELIVERY_UNCONFIRMED,
} from './broadcast-delivery';
vi.mock('server-only', () => ({}));

// Isolated local harness only; no application connection strings are used.
const execute = promisify(execFile);
const sql = async (query: string) =>
  (
    await execute('/opt/homebrew/opt/postgresql@14/bin/psql', [
      '-X',
      '-h',
      '/tmp',
      '-p',
      '55440',
      '-d',
      'postgres',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ])
  ).stdout.trim();
const quote = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
const identity = { broadcastId: 'b', recipientId: 'r', contactId: 'c' };

// Execute the helper's actual conditional UPDATE against PostgreSQL, with two
// independent connections. Only this test table is accessible to the adapter.
const db = {
  from(table: string) {
    expect(table).toBe('broadcast_recipients');
    let patch: Record<string, unknown> = {};
    const predicates: string[] = [];
    const query = {
      update: (value: Record<string, unknown>) => {
        patch = value;
        return query;
      },
      eq: (key: string, value: unknown) => {
        predicates.push(`${key}=${quote(value)}`);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        predicates.push(`${key} IN (${values.map(quote).join(',')})`);
        return query;
      },
      is: (key: string, value: unknown) => {
        expect(value).toBeNull();
        predicates.push(`${key} IS NULL`);
        return query;
      },
      or: (expression: string) => {
        expect(expression).toBe(
          `error_message.is.null,error_message.neq.${BROADCAST_DELIVERY_UNCONFIRMED}`
        );
        predicates.push(
          `(error_message IS NULL OR error_message<>${quote(BROADCAST_DELIVERY_UNCONFIRMED)})`
        );
        return query;
      },
      select: () => query,
      then: async (resolve: (value: unknown) => unknown) => {
        const ids = await sql(
          `WITH claimed AS (UPDATE public.audit_broadcast_recipients SET ${Object.entries(
            patch
          )
            .map(([key, value]) => `${key}=${quote(value)}`)
            .join(
              ','
            )} WHERE ${predicates.join(' AND ')} RETURNING id) SELECT id FROM claimed CROSS JOIN pg_sleep(0.15);`
        );
        return resolve({
          data: ids ? ids.split('\n').map((id) => ({ id })) : [],
          error: null,
        });
      },
    };
    return query;
  },
} as unknown as SupabaseClient;

describe.skipIf(process.env.RGCRM_BROADCAST_PG_TEST !== '1')(
  'PostgreSQL broadcast recipient fencing',
  () => {
    beforeAll(async () => {
      expect(await sql("SELECT current_setting('cluster_name');")).toBe(
        'rgcrm-broadcast-audit'
      );
      await sql(
        "CREATE TABLE IF NOT EXISTS public.audit_broadcast_recipients(id text PRIMARY KEY, broadcast_id text, contact_id text, status text CHECK(status IN ('pending','sent','delivered','read','replied','failed')), whatsapp_message_id text, error_message text);"
      );
    });
    beforeEach(async () => {
      await sql(
        "TRUNCATE public.audit_broadcast_recipients; INSERT INTO public.audit_broadcast_recipients VALUES('r','b','c','pending',NULL,NULL);"
      );
    });
    it('allows only one of two concurrent claims and cannot reclaim an abandoned unknown outcome', async () => {
      expect(
        (
          await Promise.all([
            claimBroadcastRecipient(db, identity),
            claimBroadcastRecipient(db, identity),
          ])
        ).sort()
      ).toEqual([false, true]);
      expect(await claimBroadcastRecipient(db, identity)).toBe(false);
    });
    it('allows intentional retry of a definitively failed recipient', async () => {
      await sql(
        "UPDATE public.audit_broadcast_recipients SET status='failed',error_message='Meta rejected the request';"
      );
      expect(await claimBroadcastRecipient(db, identity)).toBe(true);
    });
    it('never reclaims an accepted or terminal recipient', async () => {
      await sql(
        "UPDATE public.audit_broadcast_recipients SET status='failed',whatsapp_message_id='wamid-accepted';"
      );
      expect(await claimBroadcastRecipient(db, identity)).toBe(false);
      await sql(
        "UPDATE public.audit_broadcast_recipients SET status='sent',whatsapp_message_id=NULL;"
      );
      expect(await claimBroadcastRecipient(db, identity)).toBe(false);
    });
    it('cannot claim another broadcast or contact', async () => {
      expect(
        await claimBroadcastRecipient(db, {
          ...identity,
          broadcastId: 'foreign',
        })
      ).toBe(false);
      expect(
        await claimBroadcastRecipient(db, { ...identity, contactId: 'foreign' })
      ).toBe(false);
    });
  }
);
