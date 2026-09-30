import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getMessageVariablePickerSource,
  listMessageVariableDefinitions,
} from './catalog';

function catalogDb(rows: Array<Record<string, unknown>>) {
  const filters: Array<[string, unknown]> = [];
  const builder = {
    select() {
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    order() {
      return builder;
    },
    then(resolve: (value: { data: typeof rows; error: null }) => unknown) {
      return Promise.resolve(
        resolve({
          data: rows.filter((row) =>
            filters.every(([column, value]) => row[column] === value)
          ),
          error: null,
        })
      );
    },
  };
  return {
    from() {
      return builder;
    },
  } as unknown as SupabaseClient;
}

const active = {
  id: 'variable-1',
  variable_key: 'contact.full_name',
  label: 'Contact full name',
  description: 'Canonical name',
  category: 'contact',
  data_type: 'text',
  source_scope: 'contact',
  resolver_key: 'contact.full_name',
  preview_value: 'Sandeep Sharma',
  default_fallback: '',
  is_sensitive: false,
  is_active: true,
  sort_order: 30,
};

const inactive = {
  ...active,
  id: 'variable-2',
  variable_key: 'contact.legacy_name',
  resolver_key: 'contact.full_name',
  is_active: false,
};

describe('message variable catalog service', () => {
  it('returns active predefined definitions in the picker source', async () => {
    const source = await getMessageVariablePickerSource({
      db: catalogDb([active, inactive]),
    });
    expect(source.predefined).toHaveLength(1);
    expect(source.predefined[0]).toMatchObject({
      variableKey: 'contact.full_name',
      resolverKey: 'contact.full_name',
      isActive: true,
    });
    expect(source.customFields).toEqual([]);
  });

  it('can include inactive definitions distinctly for administration', async () => {
    const definitions = await listMessageVariableDefinitions({
      includeInactive: true,
      db: catalogDb([active, inactive]),
    });
    expect(definitions.map((definition) => definition.isActive)).toEqual([
      true,
      false,
    ]);
  });
});
