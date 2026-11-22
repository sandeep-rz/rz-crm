import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PmsHttpClient } from './http-client';
import { RukiyeZaraPmsProvider } from './providers/rukiye-zara';
import {
  syncPmsReservation,
  SupabasePmsReservationSyncStore,
} from './reservation-sync';
import { resolve } from 'node:path';
import { reconcilePmsProperty } from './reconciliation';
import type { PmsProvider } from './provider';
import { validateRzPmsWebhookEnvelope } from './webhooks/envelope';
vi.mock('server-only', () => ({}));
const socket = process.env.RZ_CONTACT_PG_SOCKET;
const pmsDb = process.env.RZ_CONTACT_PG_DATABASE ?? 'rz_contact_v3_test';
const pmsRepo =
  process.env.RZ_CONTACT_PMS_REPO ?? resolve(process.cwd(), '../rukiye-zara');
const psql =
  process.env.RZ_CONTACT_PSQL ?? '/opt/homebrew/opt/postgresql@14/bin/psql';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const quote = (v: string) => `'${v.replaceAll("'", "''")}'`;
function sql(database: string, query: string): string {
  if (!socket || !/^\/(?:private\/)?tmp\/rz-[A-Za-z0-9_.-]+$/.test(socket))
    throw new Error('Disposable local PostgreSQL socket required');
  if (
    ![pmsDb, 'crmtest'].includes(database) ||
    !/^rz_contact_[A-Za-z0-9_]+_test$/.test(pmsDb)
  )
    throw new Error('Disposable database required');
  return execFileSync(
    psql,
    [
      '-XqAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      socket,
      '-p',
      '55452',
      '-U',
      'postgres',
      '-d',
      database,
      '-c',
      query,
    ],
    { encoding: 'utf8' }
  ).trim();
}
function json<T = Record<string, unknown>>(db: string, query: string): T {
  return JSON.parse(sql(db, query));
}
const account = '10000000-0000-4000-8000-000000000001';
const integrationId = '20000000-0000-4000-8000-000000000001';
const propertyId = '30000000-0000-4000-8000-000000000001';
const owner = '40000000-0000-4000-8000-000000000001';
const integration = {
  accountId: account,
  integrationId,
  provider: 'rukiye_zara',
  externalAccountId: '1',
};
const db = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name !== 'sync_pms_reservation_contact')
      throw new Error('Unexpected RPC');
    try {
      const result = json(
        'crmtest',
        `SELECT public.sync_pms_reservation_contact(${quote(String(args.p_account_id))}::uuid,${quote(String(args.p_integration_id))}::uuid,${quote(String(args.p_property_id))}::uuid,${quote(String(args.p_external_property_id))},${quote(String(args.p_provider))},${quote(JSON.stringify(args.p_guest))}::jsonb,${quote(JSON.stringify(args.p_reservation))}::jsonb)`
      );
      return { data: result, error: null };
    } catch (error) {
      return { data: null, error };
    }
  },
} as unknown as SupabaseClient;
async function snapshot(id: string) {
  const context = json(
    pmsDb,
    `SELECT row_to_json(v) FROM public.guest_checkin_reservation_context_view v WHERE source_record_id='${id}'`
  );
  const pmsBooking = json(
    pmsDb,
    `SELECT row_to_json(b) FROM public.pms_bookings b WHERE booking_id='${id}'`
  );
  const { normalizeReservation } = await import(
    /* @vite-ignore */ `${pmsRepo}/apps/rz-api/src/app/v1/integrations/rz-crm/_lib/data.ts`
  );
  const canonical = normalizeReservation({
    context,
    pmsBooking,
    propertyCurrency: 'INR',
  });
  const provider = new RukiyeZaraPmsProvider(
    new PmsHttpClient({
      baseUrl: 'https://pms.example.test',
      keyId: 'fixture',
      secret: 'fixture',
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: canonical }), {
          headers: { 'content-type': 'application/json' },
        }),
    })
  );
  return provider.getReservation({
    integration,
    externalPropertyId: '1',
    externalReservationId: id,
  });
}
async function sync(id: string) {
  return syncPmsReservation(
    {
      accountId: account,
      integration,
      property: { id: propertyId, externalPropertyId: '1' },
      reservation: await snapshot(id),
    },
    new SupabasePmsReservationSyncStore(db)
  );
}
function host(patch: object) {
  sql(
    pmsDb,
    `SELECT public.update_pms_booking_guest('${A}',${quote(JSON.stringify(patch))}::jsonb)`
  );
}

describe.skipIf(!socket)(
  'PMS outbox → real API projection/adapter → CRM SQL integration',
  () => {
    beforeEach(() => {
      expect(
        sql(pmsDb, 'SELECT count(*) FROM private.contact_fixture_marker')
      ).toBe('1');
      expect(
        sql(
          'crmtest',
          'SELECT count(*) FROM public.test_contact_sync_fixture_marker'
        )
      ).toBe('1');
      sql(
        pmsDb,
        readFileSync(
          `${pmsRepo}/apps/rz-api/supabase/tests/fixtures/guest-contact-seed.sql`,
          'utf8'
        )
      );
      sql(
        'crmtest',
        `TRUNCATE public.automation_pending_executions,public.automation_logs,public.automation_trigger_jobs,public.pms_contact_external_identities,public.pms_reservations,public.pms_webhook_events,public.pms_properties,public.pms_integrations,public.contacts CASCADE;
      INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${owner}','contact-fixture@example.test','{}') ON CONFLICT(id) DO NOTHING;
      INSERT INTO public.accounts(id,name,owner_user_id) VALUES('${account}','Contact fixture','${owner}') ON CONFLICT(id) DO NOTHING;
      INSERT INTO public.pms_integrations(id,account_id,provider,external_account_id,status) VALUES('${integrationId}','${account}','rukiye_zara','1','connected');
      INSERT INTO public.pms_properties(id,account_id,pms_integration_id,external_property_id,initial_sync_status) VALUES('${propertyId}','${account}','${integrationId}','1','completed');`
      );
    });

    it('dispatches one committed update per shared stay and reconciles late OTA enrichment idempotently', async () => {
      const initialA = await sync(A);
      const initialB = await sync(B);
      const boundary = sql(
        pmsDb,
        'SELECT max(reservation_updated_at) FROM public.guest_checkin_reservation_context_view'
      );
      sql(
        pmsDb,
        `TRUNCATE public.webhook_deliveries,public.domain_events;
        UPDATE public.pms_bookings SET details='{"customer":{"name":"Guest","email":"guest@example.test","phone":"+442079460958"}}' WHERE booking_id='${A}'`
      );
      expect(sql(pmsDb, 'SELECT count(*) FROM public.domain_events')).toBe('3');
      expect(
        sql(
          pmsDb,
          `SELECT count(*) FROM public.webhook_deliveries d
        JOIN public.domain_events e ON e.id=d.domain_event_id
        JOIN public.guest_checkin_reservation_context_view v ON v.source_record_id::text=e.resource_id
        WHERE d.status='pending' AND e.occurred_at=v.reservation_updated_at
          AND (e.data->>'source_updated_at')::timestamptz=v.reservation_updated_at`
        )
      ).toBe('3');
      const markCompleted = vi.fn(async () => {});
      const listReservations = vi.fn(
        async (input: { updatedSince?: string | null }) => {
          const ids = json<string[]>(
            pmsDb,
            `SELECT json_agg(source_record_id ORDER BY source_record_id)
          FROM public.guest_checkin_reservation_context_view WHERE source_type='pms_booking'
            AND reservation_updated_at>=${quote(input.updatedSince!)}::timestamptz`
          );
          return {
            items: await Promise.all(ids.map(snapshot)),
            hasMore: false,
            nextCursor: null,
          };
        }
      );
      const claim = {
        propertyId,
        accountId: account,
        externalPropertyId: '1',
        lastReconciledAt: boundary,
        integration,
        processingStartedAt: new Date().toISOString(),
        attemptCount: 1,
      };
      const dependencies = {
        store: {
          claimProperties: async () => [],
          markCompleted,
          markFailed: vi.fn(async () => {}),
        },
        reservationStore: new SupabasePmsReservationSyncStore(db),
        createProvider: () => ({ listReservations }) as unknown as PmsProvider,
      };
      const result = await reconcilePmsProperty(claim, dependencies);
      expect(result.status).toBe('completed');
      expect(result.reservationsProcessed).toBe(2);
      expect(listReservations).toHaveBeenCalledWith(
        expect.objectContaining({ updatedSince: boundary })
      );
      expect(markCompleted).toHaveBeenCalledWith(
        claim,
        claim.processingStartedAt
      );
      expect(
        sql(
          'crmtest',
          `SELECT count(*) FROM public.contacts WHERE phone='+442079460958'`
        )
      ).toBe('1');
      expect(
        sql(
          'crmtest',
          `SELECT count(*) FROM public.pms_reservations WHERE id IN ('${initialA.reservationId}','${initialB.reservationId}')`
        )
      ).toBe('2');
      sql(
        pmsDb,
        `UPDATE public.pms_bookings SET details=details WHERE booking_id='${A}'`
      );
      expect((await reconcilePmsProperty(claim, dependencies)).status).toBe(
        'completed'
      );
      expect(sql(pmsDb, 'SELECT count(*) FROM public.domain_events')).toBe('3');
      expect(sql(pmsDb, 'SELECT count(*) FROM public.webhook_deliveries')).toBe(
        '3'
      );
      expect(sql('crmtest', 'SELECT count(*) FROM public.contacts')).toBe('1');
      for (const id of [A, B]) expect((await sync(id)).skippedStale).toBe(true);
    });

    it('syncs a late host phone to each affected reservation without replacing IDs or duplicating contacts', async () => {
      const firstA = await sync(A);
      const firstB = await sync(B);
      host({ phone: '+14155550123' });
      const eventIds = json<string[]>(
        pmsDb,
        "SELECT json_agg(resource_id) FROM public.domain_events WHERE event_type='reservation.updated'"
      );
      expect(eventIds).toContain(A);
      expect(eventIds).toContain(B);
      const nextA = await sync(A);
      const nextB = await sync(B);
      expect(nextA.reservationId).toBe(firstA.reservationId);
      expect(nextB.reservationId).toBe(firstB.reservationId);
      expect(nextA.contactId).toBe(nextB.contactId);
      expect(
        sql(
          'crmtest',
          "SELECT count(*) FROM public.contacts WHERE account_id='" +
            account +
            "'"
        )
      ).toBe('1');
      expect(
        sql(
          'crmtest',
          `SELECT phone FROM public.contacts WHERE id='${nextA.contactId}'`
        )
      ).toBe('+14155550123');
      expect((await sync(A)).skippedStale).toBe(true);
    });

    it('does not discard a contact-only version one microsecond newer in the same JavaScript millisecond', async () => {
      sql(
        pmsDb,
        `UPDATE public.pms_bookings SET updated_at='2099-01-01T00:00:00.000000Z' WHERE booking_id='${B}'`
      );
      host({ phone: '+14155550123' });
      const before = await snapshot(A);
      await sync(A);
      host({ phone: '+442079460958' });
      const after = await snapshot(A);
      expect(Date.parse(before.updatedAt!)).toBe(Date.parse(after.updatedAt!));
      expect(before.updatedAt).not.toBe(after.updatedAt);
      const saved = await sync(A);
      expect(saved.skippedStale).toBe(false);
      expect(
        sql(
          'crmtest',
          `SELECT phone FROM public.contacts WHERE id='${saved.contactId}'`
        )
      ).toBe('+442079460958');
      expect(
        sql(
          'crmtest',
          `SELECT external_updated_at=${quote(after.updatedAt!)}::timestamptz FROM public.pms_reservations WHERE id='${saved.reservationId}'`
        )
      ).toBe('t');
    });

    it('propagates explicit clears end to end and rejects an older reservation snapshot', async () => {
      host({ phone: '+14155550123' });
      const old = await snapshot(A);
      const original = await sync(A);
      host({ phone: '' });
      const cleared = await snapshot(A);
      expect(cleared.guest.clearedFields).toContain('phone');
      const saved = await sync(A);
      expect(saved.reservationId).toBe(original.reservationId);
      expect(
        sql(
          'crmtest',
          `SELECT phone FROM public.contacts WHERE id='${saved.contactId}'`
        )
      ).toBe('');
      const stale = await syncPmsReservation(
        {
          accountId: account,
          integration,
          property: { id: propertyId, externalPropertyId: '1' },
          reservation: old,
        },
        new SupabasePmsReservationSyncStore(db)
      );
      expect(stale.skippedStale).toBe(true);
      expect(
        sql(
          'crmtest',
          `SELECT phone FROM public.contacts WHERE id='${saved.contactId}'`
        )
      ).toBe('');
      const event = json<{ occurred_at: string }>(
        pmsDb,
        `SELECT json_build_object('id',e.id,'type',e.event_type,'api_version','v1','occurred_at',e.occurred_at,'property_id',e.property_id,'resource',json_build_object('type','reservation','id',e.resource_id),'source',json_build_object('type',e.source_type,'id',e.source_record_id),'data',e.data) FROM public.domain_events e WHERE resource_id='${A}' ORDER BY occurred_at DESC LIMIT 1`
      );
      const validated = validateRzPmsWebhookEnvelope(event);
      expect(validated.success).toBe(true);
      if (validated.success)
        expect(validated.data.occurred_at).toBe(event.occurred_at);
    });
  }
);
