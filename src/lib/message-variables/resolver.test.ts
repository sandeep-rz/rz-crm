import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { MessageVariableContext } from './context';
import {
  buildAndResolveMessageVariables,
  resolveMessageVariables,
} from './resolver';

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const client = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const inFilters: Array<[string, unknown[]]> = [];
      const matching = () =>
        (seed[table] ?? []).filter(
          (row) =>
            filters.every(([column, value]) => row[column] === value) &&
            inFilters.every(([column, values]) => values.includes(row[column]))
        );
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        in(column: string, values: unknown[]) {
          inFilters.push([column, values]);
          return builder;
        },
        order() {
          return builder;
        },
        async maybeSingle() {
          calls.push({ table, filters: [...filters] });
          return { data: matching()[0] ?? null, error: null };
        },
        then(resolve: (result: { data: Row[]; error: null }) => unknown) {
          calls.push({ table, filters: [...filters] });
          return Promise.resolve(resolve({ data: matching(), error: null }));
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function definition(
  variableKey: string,
  resolverKey = variableKey,
  overrides: Partial<Row> = {}
): Row {
  const category = variableKey.split('.')[0];
  return {
    id: `catalog-${variableKey}`,
    variable_key: variableKey,
    label: variableKey,
    description: null,
    category,
    data_type: 'text',
    source_scope: category,
    resolver_key: resolverKey,
    preview_value: null,
    default_fallback: null,
    is_sensitive: false,
    is_active: true,
    sort_order: 1,
    ...overrides,
  };
}

const catalog = [
  definition('contact.first_name'),
  definition('contact.phone', 'contact.phone', { is_sensitive: true }),
  definition('property.name'),
  definition('reservation.check_in'),
  definition('reservation.nights', 'reservation.nights', {
    data_type: 'number',
  }),
  definition('workspace.name'),
  definition('contact.fallback_name', 'contact.last_name', {
    default_fallback: 'Guest',
  }),
  definition('contact.inactive', 'contact.full_name', { is_active: false }),
  definition('contact.unsafe', 'contact.__proto__.phone'),
];

const context: MessageVariableContext = {
  contact: {
    id: 'contact-a',
    first_name: 'Sandeep',
    last_name: null,
    full_name: 'Sandeep Sharma',
    phone: '+910000000000',
    email: 'private@example.com',
  },
  reservation: {
    id: 'reservation-a',
    reference: 'ABC123',
    status: 'confirmed',
    check_in: '2026-10-15',
    check_out: '2026-10-18',
    nights: 3,
    guest_count: 2,
    adult_count: 2,
    child_count: 0,
    channel: 'Direct',
    amount: '12500.50',
    currency: 'INR',
  },
  property: {
    id: 'property-a',
    name: 'Lakeside Meadows',
  },
  workspace: { id: 'account-a', name: 'Workspace A' },
};

function resolve(
  mappings: unknown,
  options: {
    context?: MessageVariableContext;
    seed?: Record<string, Row[]>;
    accountId?: string;
  } = {}
) {
  const { client } = fakeDb({
    message_variable_catalog: catalog,
    ...(options.seed ?? {}),
  });
  return resolveMessageVariables({
    accountId: options.accountId ?? 'account-a',
    mappings,
    context: options.context ?? context,
    db: client,
  });
}

const catalogMapping = (variable_key: string, position = 1) => ({
  component: 'body',
  position,
  source_type: 'catalog_variable',
  variable_key,
});

describe('resolveMessageVariables', () => {
  it('rejects a retired hospitality mapping even when it has a fallback', async () => {
    const result = await resolve([
      { ...catalogMapping('property.wifi_password'), fallback: 'obsolete' },
    ]);
    expect(result).toMatchObject({
      success: false,
      values: [],
      errors: [
        {
          code: 'UNKNOWN_CATALOG_VARIABLE',
          variable_key: 'property.wifi_password',
        },
      ],
    });
  });

  it('reports a missing contact value without exposing a sensitive sibling', async () => {
    const result = await resolve([catalogMapping('contact.phone')], {
      context: { ...context, contact: { ...context.contact!, phone: null } },
    });
    expect(result).toMatchObject({
      success: false,
      missing: [
        { variable_key: 'contact.phone', reason: 'MISSING_CONTEXT_VALUE' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private@example.com');
  });

  it.each([
    ['contact.first_name', 'Sandeep'],
    ['property.name', 'Lakeside Meadows'],
    ['reservation.check_in', '2026-10-15'],
    ['workspace.name', 'Workspace A'],
  ])('resolves %s from semantic context', async (key, expected) => {
    const result = await resolve([catalogMapping(key)]);
    expect(result).toMatchObject({
      success: true,
      values: [{ variable_key: key, value: expected }],
    });
  });

  it('resolves and trims a static value', async () => {
    const result = await resolve([
      {
        component: 'body',
        position: 1,
        source_type: 'static',
        static_value: '  Reception  ',
      },
    ]);
    expect(result.values[0]).toMatchObject({ value: 'Reception' });
  });

  it('orders body mappings by numeric position', async () => {
    const result = await resolve([
      { ...catalogMapping('workspace.name', 3) },
      { ...catalogMapping('contact.first_name', 1) },
      { ...catalogMapping('property.name', 2) },
    ]);
    expect(result.values.map((item) => item.position)).toEqual([1, 2, 3]);
  });

  it('rejects duplicate component positions', async () => {
    const result = await resolve([
      catalogMapping('contact.first_name'),
      catalogMapping('workspace.name'),
    ]);
    expect(result.errors[0]?.code).toBe('DUPLICATE_POSITION');
  });

  it('rejects zero positions', async () => {
    const result = await resolve([catalogMapping('contact.first_name', 0)]);
    expect(result.errors[0]?.code).toBe('INVALID_POSITION');
  });

  it('rejects an unknown catalog variable', async () => {
    const result = await resolve([catalogMapping('contact.unknown')]);
    expect(result.errors[0]?.code).toBe('UNKNOWN_CATALOG_VARIABLE');
  });

  it('rejects an inactive catalog variable', async () => {
    const result = await resolve([catalogMapping('contact.inactive')]);
    expect(result.errors[0]?.code).toBe('INACTIVE_CATALOG_VARIABLE');
  });

  it('rejects an invalid source type', async () => {
    const result = await resolve([
      { component: 'body', position: 1, source_type: 'mystery' },
    ]);
    expect(result.errors[0]?.code).toBe('UNKNOWN_SOURCE_TYPE');
  });

  it('rejects a missing static value', async () => {
    const result = await resolve([
      {
        component: 'body',
        position: 1,
        source_type: 'static',
        static_value: '   ',
      },
    ]);
    expect(result.errors[0]?.code).toBe('STATIC_VALUE_REQUIRED');
  });

  it('rejects unsupported button mappings until button identity is explicit', async () => {
    const result = await resolve([
      { ...catalogMapping('contact.first_name'), component: 'button' },
    ]);
    expect(result.errors[0]?.code).toBe('UNSUPPORTED_COMPONENT');
  });

  it('returns missing context for a reservation variable in contact-only context', async () => {
    const result = await resolve([catalogMapping('reservation.check_in')], {
      context: {
        contact: context.contact,
        workspace: context.workspace,
      },
    });
    expect(result).toMatchObject({
      success: false,
      missing: [
        {
          variable_key: 'reservation.check_in',
          reason: 'MISSING_CONTEXT_VALUE',
        },
      ],
    });
  });

  it('handles a missing contact value without stringifying null', async () => {
    const result = await resolve([catalogMapping('contact.first_name')], {
      context: {
        contact: { ...context.contact!, first_name: null },
        workspace: context.workspace,
      },
    });
    expect(result.missing).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('"value":"null"');
  });

  it('uses mapping fallback before catalog fallback', async () => {
    const result = await resolve([
      { ...catalogMapping('contact.fallback_name'), fallback: 'Traveller' },
    ]);
    expect(result.values[0]?.value).toBe('Traveller');
  });

  it('uses catalog fallback when runtime and mapping fallback are absent', async () => {
    const result = await resolve([catalogMapping('contact.fallback_name')]);
    expect(result.values[0]?.value).toBe('Guest');
  });

  it('preserves actual numeric zero as "0"', async () => {
    const result = await resolve([catalogMapping('reservation.nights')], {
      context: {
        ...context,
        reservation: { ...context.reservation!, nights: 0 },
      },
    });
    expect(result.values[0]?.value).toBe('0');
  });

  it('does not invent zero for a missing numeric value', async () => {
    const result = await resolve([catalogMapping('reservation.nights')], {
      context: {
        ...context,
        reservation: { ...context.reservation!, nights: null },
      },
    });
    expect(result.values).toEqual([]);
    expect(result.missing[0]?.reason).toBe('MISSING_CONTEXT_VALUE');
  });

  it('resolves an account-owned custom field for the current owned contact', async () => {
    const result = await resolve(
      [
        {
          component: 'body',
          position: 1,
          source_type: 'custom_field',
          custom_field_id: 'field-a',
        },
      ],
      {
        seed: {
          custom_fields: [{ id: 'field-a', account_id: 'account-a' }],
          contacts: [{ id: 'contact-a', account_id: 'account-a' }],
          contact_custom_values: [
            {
              contact_id: 'contact-a',
              custom_field_id: 'field-a',
              value: 'VIP',
            },
          ],
        },
      }
    );
    expect(result.values[0]).toMatchObject({
      custom_field_id: 'field-a',
      value: 'VIP',
    });
  });

  it('rejects a custom field owned by another account', async () => {
    const result = await resolve(
      [
        {
          component: 'body',
          position: 1,
          source_type: 'custom_field',
          custom_field_id: 'field-b',
        },
      ],
      {
        seed: {
          custom_fields: [{ id: 'field-b', account_id: 'account-b' }],
        },
      }
    );
    expect(result.errors[0]).toMatchObject({
      code: 'CUSTOM_FIELD_NOT_FOUND',
      custom_field_id: 'field-b',
    });
  });

  it('reports missing custom-field context when there is no contact', async () => {
    const result = await resolve(
      [
        {
          component: 'body',
          position: 1,
          source_type: 'custom_field',
          custom_field_id: 'field-a',
        },
      ],
      {
        context: { workspace: context.workspace },
        seed: {
          custom_fields: [{ id: 'field-a', account_id: 'account-a' }],
        },
      }
    );
    expect(result.missing[0]?.reason).toBe('CUSTOM_FIELD_CONTEXT_MISSING');
  });

  it('reports a missing custom-field value when contact context exists', async () => {
    const result = await resolve(
      [
        {
          component: 'body',
          position: 1,
          source_type: 'custom_field',
          custom_field_id: 'field-a',
        },
      ],
      {
        seed: {
          custom_fields: [{ id: 'field-a', account_id: 'account-a' }],
          contacts: [{ id: 'contact-a', account_id: 'account-a' }],
          contact_custom_values: [
            {
              contact_id: 'contact-a',
              custom_field_id: 'field-a',
              value: '   ',
            },
          ],
        },
      }
    );
    expect(result.missing[0]?.reason).toBe('CUSTOM_FIELD_VALUE_MISSING');
  });

  it('honors custom-field mapping fallback without a contact value', async () => {
    const result = await resolve(
      [
        {
          component: 'body',
          position: 1,
          source_type: 'custom_field',
          custom_field_id: 'field-a',
          fallback: 'Standard guest',
        },
      ],
      {
        context: { workspace: context.workspace },
        seed: {
          custom_fields: [{ id: 'field-a', account_id: 'account-a' }],
        },
      }
    );
    expect(result).toMatchObject({
      success: true,
      values: [{ value: 'Standard guest' }],
      missing: [],
    });
  });

  it('rejects a context built for another account', async () => {
    const result = await resolve([catalogMapping('contact.first_name')], {
      context: {
        ...context,
        workspace: { id: 'account-b', name: 'Workspace B' },
      },
    });
    expect(result.errors[0]?.code).toBe('CONTEXT_ACCOUNT_MISMATCH');
  });

  it('does not emit sensitive runtime values in missing/error diagnostics', async () => {
    const result = await resolve(
      [catalogMapping('contact.phone'), catalogMapping('contact.unknown', 2)],
      {
        context: {
          contact: { ...context.contact!, phone: '+919999999999' },
          workspace: context.workspace,
        },
      }
    );
    expect(JSON.stringify(result.errors)).not.toContain('+919999999999');
    expect(JSON.stringify(result.missing)).not.toContain('+919999999999');
  });

  it('uses the catalog resolver_key rather than treating labels as identity', async () => {
    const result = await resolve([catalogMapping('contact.fallback_name')], {
      context: {
        contact: { ...context.contact!, last_name: 'Sharma' },
        workspace: context.workspace,
      },
    });
    expect(result.values[0]?.value).toBe('Sharma');
  });

  it('routes catalog resolver keys through the safe path resolver', async () => {
    const result = await resolve([catalogMapping('contact.unsafe')]);
    expect(result).toMatchObject({
      success: false,
      values: [],
      missing: [
        {
          variable_key: 'contact.unsafe',
          reason: 'MISSING_CONTEXT_VALUE',
        },
      ],
    });
  });

  it('supports the existing single text-header parameter position', async () => {
    const result = await resolve([
      { ...catalogMapping('contact.first_name'), component: 'header' },
    ]);
    expect(result.values[0]).toMatchObject({
      component: 'header',
      position: 1,
      value: 'Sandeep',
    });
  });
});

describe('buildAndResolveMessageVariables', () => {
  const workspaceRow = { id: 'account-a', name: 'Workspace A' };
  const contactRow = {
    id: 'contact-a',
    account_id: 'account-a',
    name: 'Sandeep Sharma',
    phone: '+910000000000',
    email: 'private@example.com',
  };
  const propertyRow = {
    id: 'property-a',
    account_id: 'account-a',
    name: 'Lakeside Meadows',
  };
  const reservationRow = {
    id: 'reservation-a',
    account_id: 'account-a',
    pms_property_id: 'property-a',
    contact_id: 'contact-a',
    reservation_code: 'ABC123',
    status: 'confirmed',
    check_in: '2026-10-15',
    check_out: '2026-10-18',
    adults: 2,
    children: 0,
    infants: 0,
    occupancy_total: 2,
    channel_code: 'direct',
    channel_name: 'Direct',
    total_amount: '12500.50',
    currency: 'INR',
  };

  function highLevelDb(overrides: Record<string, Row[]> = {}) {
    return fakeDb({
      accounts: [workspaceRow],
      contacts: [contactRow],
      pms_properties: [propertyRow],
      pms_reservations: [reservationRow],
      message_variable_catalog: catalog,
      ...overrides,
    }).client;
  }

  it('builds validated CRM context and resolves mappings', async () => {
    const result = await buildAndResolveMessageVariables({
      accountId: 'account-a',
      reservationId: 'reservation-a',
      mappings: [catalogMapping('contact.first_name')],
      db: highLevelDb(),
    });
    expect(result).toMatchObject({
      success: true,
      values: [{ variable_key: 'contact.first_name', value: 'Sandeep' }],
    });
  });

  it('rejects a cross-account contact through context construction', async () => {
    await expect(
      buildAndResolveMessageVariables({
        accountId: 'account-a',
        contactId: 'contact-a',
        mappings: [catalogMapping('contact.first_name')],
        db: highLevelDb({
          contacts: [{ ...contactRow, account_id: 'account-b' }],
        }),
      })
    ).rejects.toMatchObject({ code: 'entity_not_found' });
  });

  it('rejects a cross-account reservation through context construction', async () => {
    await expect(
      buildAndResolveMessageVariables({
        accountId: 'account-a',
        reservationId: 'reservation-a',
        mappings: [catalogMapping('reservation.check_in')],
        db: highLevelDb({
          pms_reservations: [{ ...reservationRow, account_id: 'account-b' }],
        }),
      })
    ).rejects.toMatchObject({ code: 'entity_not_found' });
  });

  it('rejects relationship conflicts through context construction', async () => {
    await expect(
      buildAndResolveMessageVariables({
        accountId: 'account-a',
        reservationId: 'reservation-a',
        contactId: 'contact-b',
        mappings: [catalogMapping('contact.first_name')],
        db: highLevelDb(),
      })
    ).rejects.toMatchObject({ code: 'relationship_conflict' });
  });
});
