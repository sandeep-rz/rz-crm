import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getPropertyCommunicationSettings,
  normalizePropertyCommunicationPatch,
  PropertyCommunicationSettingsError,
  upsertPropertyCommunicationSettings,
} from './communication-settings';

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [
      table,
      rows.map((row) => ({ ...row })),
    ])
  ) as Record<string, Row[]>;
  const upserts: Row[] = [];

  const client = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let pendingUpsert: Row | null = null;
      const matching = () =>
        (tables[table] ?? []).filter((row) =>
          filters.every(([column, value]) => row[column] === value)
        );
      const performUpsert = () => {
        if (!pendingUpsert) return null;
        upserts.push({ ...pendingUpsert });
        tables[table] ??= [];
        const existing = tables[table].find(
          (row) =>
            row.account_id === pendingUpsert?.account_id &&
            row.pms_property_id === pendingUpsert?.pms_property_id
        );
        if (existing) {
          Object.assign(existing, pendingUpsert);
          return existing;
        }
        const inserted = {
          id: `settings-${tables[table].length + 1}`,
          ...pendingUpsert,
        };
        tables[table].push(inserted);
        return inserted;
      };
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        upsert(payload: Row) {
          pendingUpsert = payload;
          return builder;
        },
        async maybeSingle() {
          return { data: matching()[0] ?? null, error: null };
        },
        async single() {
          return { data: performUpsert(), error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, tables, upserts };
}

const properties = [
  { id: 'property-a', account_id: 'account-a', name: 'Lake House' },
  { id: 'property-b', account_id: 'account-a', name: 'Hill House' },
  { id: 'property-c', account_id: 'account-b', name: 'Foreign House' },
];

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((caught) => caught);
  expect(error).toBeInstanceOf(PropertyCommunicationSettingsError);
  expect((error as PropertyCommunicationSettingsError).code).toBe(code);
}

describe('property communication settings service', () => {
  it('treats no settings row as valid and returns null optional values', async () => {
    const { client } = fakeDb({ pms_properties: properties });
    const result = await getPropertyCommunicationSettings({
      accountId: 'account-a',
      pmsPropertyId: 'property-a',
      db: client,
    });
    expect(result.id).toBeNull();
    expect(result.map_url).toBeNull();
    expect(result.wifi_password).toBeNull();
  });

  it('creates partial settings without inventing other values', async () => {
    const { client, upserts } = fakeDb({ pms_properties: properties });
    const result = await upsertPropertyCommunicationSettings({
      accountId: 'account-a',
      pmsPropertyId: 'property-a',
      values: { map_url: ' https://maps.example/a ' },
      db: client,
    });
    expect(upserts[0]).toEqual({
      account_id: 'account-a',
      pms_property_id: 'property-a',
      map_url: 'https://maps.example/a',
    });
    expect(result.map_url).toBe('https://maps.example/a');
    expect(result.directions).toBeNull();
  });

  it('updates one value without erasing unrelated values', async () => {
    const { client, tables } = fakeDb({
      pms_properties: properties,
      property_communication_settings: [
        {
          id: 'settings-a',
          account_id: 'account-a',
          pms_property_id: 'property-a',
          map_url: 'https://maps.example/a',
          wifi_name: 'LakeGuest',
        },
      ],
    });
    const result = await upsertPropertyCommunicationSettings({
      accountId: 'account-a',
      pmsPropertyId: 'property-a',
      values: { map_url: 'https://maps.example/new' },
      db: client,
    });
    expect(result.map_url).toBe('https://maps.example/new');
    expect(result.wifi_name).toBe('LakeGuest');
    expect(tables.property_communication_settings[0].wifi_name).toBe(
      'LakeGuest'
    );
  });

  it('clears an individual value with blank input and preserves other values', async () => {
    const { client } = fakeDb({
      pms_properties: properties,
      property_communication_settings: [
        {
          id: 'settings-a',
          account_id: 'account-a',
          pms_property_id: 'property-a',
          map_url: 'https://maps.example/a',
          wifi_name: 'LakeGuest',
        },
      ],
    });
    const result = await upsertPropertyCommunicationSettings({
      accountId: 'account-a',
      pmsPropertyId: 'property-a',
      values: { map_url: '   ' },
      db: client,
    });
    expect(result.map_url).toBeNull();
    expect(result.wifi_name).toBe('LakeGuest');
  });

  it('keeps different properties independent', async () => {
    const { client } = fakeDb({
      pms_properties: properties,
      property_communication_settings: [
        {
          id: 'settings-a',
          account_id: 'account-a',
          pms_property_id: 'property-a',
          directions: 'Turn left',
        },
        {
          id: 'settings-b',
          account_id: 'account-a',
          pms_property_id: 'property-b',
          directions: 'Turn right',
        },
      ],
    });
    const first = await getPropertyCommunicationSettings({
      accountId: 'account-a',
      pmsPropertyId: 'property-a',
      db: client,
    });
    const second = await getPropertyCommunicationSettings({
      accountId: 'account-a',
      pmsPropertyId: 'property-b',
      db: client,
    });
    expect(first.directions).toBe('Turn left');
    expect(second.directions).toBe('Turn right');
  });

  it('rejects an account/property mismatch before read or write', async () => {
    const { client } = fakeDb({ pms_properties: properties });
    await expectCode(
      getPropertyCommunicationSettings({
        accountId: 'account-a',
        pmsPropertyId: 'property-c',
        db: client,
      }),
      'property_not_found'
    );
    await expectCode(
      upsertPropertyCommunicationSettings({
        accountId: 'account-a',
        pmsPropertyId: 'property-c',
        values: { wifi_name: 'Leaked' },
        db: client,
      }),
      'property_not_found'
    );
  });

  it('rejects unsupported fields and non-string values', () => {
    expect(() =>
      normalizePropertyCommunicationPatch({ source: 'pms' })
    ).toThrow(PropertyCommunicationSettingsError);
    expect(() =>
      normalizePropertyCommunicationPatch({ wifi_name: 123 })
    ).toThrow(PropertyCommunicationSettingsError);
  });
});
