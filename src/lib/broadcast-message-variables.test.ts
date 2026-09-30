import { describe, expect, it } from 'vitest';

import {
  frozenTemplateParams,
  getBroadcastVariableCapabilities,
  inspectBroadcastVariableSlots,
  missingVariableIdentity,
  resolvedVariablesToSendParams,
  validateBroadcastVariableMappings,
} from './broadcast-message-variables';
import type {
  MessageVariableDefinition,
  MessageVariableMapping,
  ResolveMessageVariablesResult,
} from './message-variables';
import type { MessageTemplate } from '@/types';
import { resolveVariables } from '@/hooks/use-broadcast-sending';

function definition(
  variableKey: string,
  sourceScope: MessageVariableDefinition['sourceScope'],
  isActive = true
): MessageVariableDefinition {
  return {
    id: variableKey,
    variableKey,
    label: variableKey,
    description: null,
    category: sourceScope,
    dataType: 'text',
    sourceScope,
    resolverKey: variableKey,
    previewValue: `Preview ${variableKey}`,
    defaultFallback: null,
    isSensitive: false,
    isActive,
    sortOrder: 0,
  };
}

function template(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 'template-1',
    user_id: 'user-1',
    name: 'arrival',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Hi {{2}}, reference {{1}}',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const bodyMapping = (
  variableKey: string,
  position = 1
): MessageVariableMapping => ({
  component: 'body',
  position,
  source_type: 'catalog_variable',
  variable_key: variableKey,
});

describe('Broadcast semantic message variables', () => {
  it('discovers BODY and TEXT HEADER slots independently and deterministically', () => {
    expect(
      inspectBroadcastVariableSlots(
        template({
          header_type: 'text',
          header_content: 'Hello {{1}}',
        })
      )
    ).toEqual([
      { component: 'header', position: 1 },
      { component: 'body', position: 1 },
      { component: 'body', position: 2 },
    ]);
  });

  it('allows only contact/workspace scopes for current contact audiences', () => {
    const capabilities = getBroadcastVariableCapabilities();
    expect(capabilities).toEqual({
      contact: true,
      workspace: true,
      property: false,
      reservation: false,
    });
  });

  it('enables property and reservation only from explicit trusted context', () => {
    expect(
      getBroadcastVariableCapabilities({ propertyId: 'property-1' })
    ).toMatchObject({
      property: true,
      reservation: false,
    });
    expect(
      getBroadcastVariableCapabilities({ reservationId: 'reservation-1' })
    ).toMatchObject({ property: true, reservation: true });
  });

  it('is catalog-driven: a supplied active definition works without a hardcoded key', () => {
    const key = 'contact.future_variable';
    expect(
      validateBroadcastVariableMappings({
        mappings: [bodyMapping(key)],
        slots: [{ component: 'body', position: 1 }],
        definitions: [definition(key, 'contact')],
        capabilities: getBroadcastVariableCapabilities(),
      })
    ).toEqual([]);
  });

  it('rejects inactive, unknown, and context-unavailable catalog variables', () => {
    const definitions = [
      definition('contact.inactive', 'contact', false),
      definition('reservation.check_in', 'reservation'),
      definition('property.wifi_name', 'property'),
    ];
    for (const [key, issue] of [
      ['contact.inactive', 'INACTIVE_CATALOG_VARIABLE'],
      ['contact.unknown', 'UNKNOWN_CATALOG_VARIABLE'],
      ['reservation.check_in', 'CONTEXT_UNAVAILABLE'],
      ['property.wifi_name', 'CONTEXT_UNAVAILABLE'],
    ]) {
      expect(
        validateBroadcastVariableMappings({
          mappings: [bodyMapping(key)],
          slots: [{ component: 'body', position: 1 }],
          definitions,
          capabilities: getBroadcastVariableCapabilities(),
        })[0]
      ).toContain(issue);
    }
  });

  it('accepts custom-field and static mappings without a second catalog', () => {
    const mappings: MessageVariableMapping[] = [
      {
        component: 'body',
        position: 1,
        source_type: 'custom_field',
        custom_field_id: 'field-1',
      },
      {
        component: 'body',
        position: 2,
        source_type: 'static',
        static_value: 'Welcome',
      },
    ];
    expect(
      validateBroadcastVariableMappings({
        mappings,
        slots: [
          { component: 'body', position: 1 },
          { component: 'body', position: 2 },
        ],
        definitions: [],
        capabilities: getBroadcastVariableCapabilities(),
      })
    ).toEqual([]);
  });

  it('rejects duplicate and missing positions', () => {
    expect(
      validateBroadcastVariableMappings({
        mappings: [
          bodyMapping('contact.full_name'),
          bodyMapping('contact.phone'),
        ],
        slots: [{ component: 'body', position: 1 }],
        definitions: [
          definition('contact.full_name', 'contact'),
          definition('contact.phone', 'contact'),
        ],
        capabilities: getBroadcastVariableCapabilities(),
      })[0]
    ).toContain('DUPLICATE_POSITION');

    expect(
      validateBroadcastVariableMappings({
        mappings: [],
        slots: [{ component: 'body', position: 1 }],
        definitions: [],
        capabilities: getBroadcastVariableCapabilities(),
      })
    ).toContain('MAPPING_REQUIRED:body:1');
  });

  it('groups resolved header/body values for the existing send builder', () => {
    const result: ResolveMessageVariablesResult = {
      success: true,
      values: [
        {
          component: 'body',
          position: 2,
          value: 'second',
          source_type: 'static',
        },
        {
          component: 'header',
          position: 1,
          value: 'header',
          source_type: 'static',
        },
        {
          component: 'body',
          position: 1,
          value: 'first',
          source_type: 'static',
        },
      ],
      missing: [],
      errors: [],
    };
    expect(resolvedVariablesToSendParams(result)).toEqual({
      headerText: 'header',
      body: ['first', 'second'],
    });
  });

  it('keeps diagnostics identity-only and never includes a resolved secret', () => {
    const result: ResolveMessageVariablesResult = {
      success: false,
      values: [],
      missing: [
        {
          component: 'body',
          position: 1,
          source_type: 'catalog_variable',
          variable_key: 'property.wifi_password',
          reason: 'MISSING_CONTEXT_VALUE',
        },
      ],
      errors: [],
    };
    const message = missingVariableIdentity(result);
    expect(message).toContain('property.wifi_password');
    expect(message).not.toContain('actual-secret');
  });

  it('preserves legacy arrays and reads structured frozen parameters', () => {
    const legacy = ['Ada', 'Friday'];
    expect(frozenTemplateParams(legacy)).toEqual({ params: legacy });
    expect(
      frozenTemplateParams({
        body: ['Ada'],
        headerText: 'Welcome',
        headerMediaUrl: 'https://example.com/image.jpg',
      })
    ).toEqual({
      messageParams: {
        body: ['Ada'],
        headerText: 'Welcome',
        headerMediaUrl: 'https://example.com/image.jpg',
      },
    });
  });

  it('keeps legacy static, contact, and custom-field mappings compatible', () => {
    const contact = {
      id: 'contact-1',
      user_id: 'user-1',
      account_id: 'account-1',
      name: 'Ada Lovelace',
      phone: '+14155550123',
      email: 'ada@example.com',
      company: 'Analytical Engines',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(
      resolveVariables(
        {
          '3': { type: 'custom_field', value: 'field-1' },
          '1': { type: 'static', value: 'Hello' },
          '2': { type: 'field', value: 'name' },
        },
        contact,
        new Map([['field-1', 'VIP']])
      )
    ).toEqual(['Hello', 'Ada Lovelace', 'VIP']);
  });
});
