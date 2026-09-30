import { describe, expect, it } from 'vitest';

import type { MessageTemplate } from '@/types';
import {
  groupResolvedTemplateParameters,
  inspectTemplateVariableSlots,
  reconcileTemplateVariableMappings,
  validateTemplateVariableMappings,
} from './template-variable-mapping';

function template(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 'template-1',
    user_id: 'user-1',
    name: 'booking_confirmation',
    language: 'en',
    category: 'Utility',
    body_text: 'Hi {{1}}, welcome to {{2}} on {{3}}.',
    status: 'APPROVED',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('automation template variable mapping', () => {
  it('discovers and numerically sorts BODY slots', () => {
    expect(
      inspectTemplateVariableSlots(
        template({ body_text: '{{3}} then {{1}} and {{2}}' })
      ).slots
    ).toEqual([
      { component: 'body', position: 1 },
      { component: 'body', position: 2 },
      { component: 'body', position: 3 },
    ]);
  });

  it('discovers the supported TEXT HEADER slot separately', () => {
    expect(
      inspectTemplateVariableSlots(
        template({ header_type: 'text', header_content: 'Booking {{1}}' })
      ).slots
    ).toEqual([
      { component: 'header', position: 1 },
      { component: 'body', position: 1 },
      { component: 'body', position: 2 },
      { component: 'body', position: 3 },
    ]);
  });

  it('requires every supported slot to be mapped', () => {
    expect(
      validateTemplateVariableMappings(template(), [
        {
          component: 'body',
          position: 1,
          source_type: 'catalog_variable',
          variable_key: 'contact.first_name',
        },
        {
          component: 'body',
          position: 3,
          source_type: 'static',
          static_value: 'tomorrow',
        },
      ])
    ).toContain('BODY parameter {{2}} needs a mapping.');
  });

  it('accepts catalog, static, and stable custom-field-id mappings', () => {
    expect(
      validateTemplateVariableMappings(template(), [
        {
          component: 'body',
          position: 1,
          source_type: 'catalog_variable',
          variable_key: 'contact.first_name',
        },
        {
          component: 'body',
          position: 2,
          source_type: 'custom_field',
          custom_field_id: 'field-uuid',
        },
        {
          component: 'body',
          position: 3,
          source_type: 'static',
          static_value: 'Reception',
        },
      ])
    ).toEqual([]);
  });

  it('surfaces unsupported dynamic URL buttons clearly', () => {
    expect(
      inspectTemplateVariableSlots(
        template({
          buttons: [
            { type: 'URL', text: 'Open', url: 'https://example.com/{{1}}' },
          ],
        })
      ).unsupported
    ).toEqual([
      'Dynamic URL button 1 is not supported by automation variable mapping yet.',
    ]);
  });

  it('reconciles a changed template by retaining only compatible slots', () => {
    expect(
      reconcileTemplateVariableMappings(
        [
          {
            component: 'body',
            position: 1,
            source_type: 'static',
            static_value: 'one',
          },
          {
            component: 'body',
            position: 3,
            source_type: 'static',
            static_value: 'three',
          },
        ],
        [
          { component: 'header', position: 1 },
          { component: 'body', position: 1 },
        ]
      )
    ).toEqual([
      {
        component: 'body',
        position: 1,
        source_type: 'static',
        static_value: 'one',
      },
    ]);
  });

  it('groups header and body values independently in numeric order', () => {
    expect(
      groupResolvedTemplateParameters([
        { component: 'body', position: 2, value: 'Property' },
        { component: 'header', position: 1, value: 'ABC123' },
        { component: 'body', position: 1, value: 'Sandeep' },
      ])
    ).toEqual({
      headerText: 'ABC123',
      body: ['Sandeep', 'Property'],
    });
  });
});
