import { describe, expect, it } from 'vitest';
import {
  buildPropertyOptions,
  contactPropertyNames,
  selectedProperty,
} from './property-context';

const integrations = [
  {
    id: 'i-a',
    account_id: 'a',
    display_name: 'RZ PMS',
    provider: 'rukiye_zara',
  },
  {
    id: 'i-b',
    account_id: 'a',
    display_name: 'Future PMS',
    provider: 'future_pms',
  },
  {
    id: 'i-foreign',
    account_id: 'b',
    display_name: 'Secret PMS',
    provider: 'custom',
  },
];
const properties = [
  {
    id: 'p-1',
    account_id: 'a',
    pms_integration_id: 'i-a',
    name: 'Beach House',
    status: 'active',
    initial_sync_status: 'completed',
  },
  {
    id: 'p-2',
    account_id: 'a',
    pms_integration_id: 'i-b',
    name: 'Beach House',
    status: 'disconnected',
    initial_sync_status: 'completed',
  },
  {
    id: 'p-foreign',
    account_id: 'b',
    pms_integration_id: 'i-foreign',
    name: 'Secret Villa',
    status: 'active',
    initial_sync_status: 'completed',
  },
];

describe('workspace property context', () => {
  it('returns only canonical properties belonging to the active workspace', () => {
    const options = buildPropertyOptions('a', properties, integrations);
    expect(options.map((option) => option.id)).toEqual(['p-1', 'p-2']);
    expect(options.map((option) => option.name)).not.toContain('Secret Villa');
  });

  it('uses canonical ids and disambiguates duplicate names with integration context', () => {
    const options = buildPropertyOptions('a', properties, integrations);
    expect(options).toMatchObject([
      { id: 'p-1', name: 'Beach House', secondaryLabel: 'RZ PMS' },
      {
        id: 'p-2',
        name: 'Beach House',
        secondaryLabel: 'Future PMS · Disconnected',
      },
    ]);
  });

  it('rejects a property from another workspace and invalidates it after switching', () => {
    expect(
      selectedProperty(
        buildPropertyOptions('a', properties, integrations),
        'p-foreign'
      )
    ).toBeNull();
    expect(
      selectedProperty(
        buildPropertyOptions('b', properties, integrations),
        'p-1'
      )
    ).toBeNull();
  });

  it('derives contact property association from reservation stays without duplicates', () => {
    expect(
      contactPropertyNames([
        { propertyName: 'Varkala Villa' },
        { propertyName: 'Varkala Villa' },
        { propertyName: 'Munnar Cottage' },
      ])
    ).toEqual(['Munnar Cottage', 'Varkala Villa']);
  });
});
