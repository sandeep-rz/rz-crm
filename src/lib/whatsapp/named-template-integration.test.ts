import { describe, expect, it, vi } from 'vitest';
import type { MessageTemplate } from '@/types';
import {
  mapImportedTemplate,
  positionalSlots,
  compileSemanticTemplate,
  type CatalogVariable,
} from './semantic-template';
import { buildMetaTemplateMessagePayload } from './meta-template-payload';
import { validatePreparationMapping } from '@/lib/message-preparation/mapping';
import { buildSendComponents } from './template-send-builder';
import { buildTemplateMessageSnapshot } from './template-message-view';
import { renderTemplateBody } from './template-body';
import { extractTemplateVariables } from './template-validators';
vi.mock('server-only', () => ({}));
const catalog: CatalogVariable[] = ['contact.first_name', 'property.name'].map(
  (variableKey) => ({
    variableKey,
    label: variableKey,
    previewValue: 'APPROVAL',
    isActive: true,
    category: 'contact',
    sortOrder: 0,
  })
);
const imported = () =>
  ({
    id: 'template',
    name: 'welcome',
    language: 'en',
    status: 'APPROVED',
    meta_template_id: 'meta',
    template_origin: 'meta',
    variable_configuration_status: 'needs_mapping',
    body_text: 'Welcome to {{property}}, {{guest}}. Hello {{guest}}!',
    header_type: 'text',
    header_content: 'For {{recipient}}',
    sample_values: {
      body: ['APPROVAL_GUEST', 'APPROVAL_PROPERTY'],
      header: ['APPROVAL_RECIPIENT'],
    },
  }) as MessageTemplate;
function mapped() {
  const row = imported();
  return {
    ...row,
    ...mapImportedTemplate(
      row,
      positionalSlots(row).map((slot) => ({
        ...slot,
        variable_key:
          slot.parameter_name === 'property'
            ? 'property.name'
            : 'contact.first_name',
      })),
      catalog
    ),
  };
}
describe('named Meta variables through the RZ semantic contract', () => {
  it('maps names to canonical variables without changing approved content', () => {
    const row = mapped();
    expect(row.body_text).toBe(imported().body_text);
    expect(row.semantic_content?.body_text).toBe(
      'Welcome to {{property.name}}, {{contact.first_name}}. Hello {{contact.first_name}}!'
    );
    expect(row.semantic_variable_mapping).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'BODY',
          position: 1,
          parameter_name: 'guest',
          variable_key: 'contact.first_name',
        }),
      ])
    );
    expect(validatePreparationMapping(row)).toHaveLength(3);
  });
  it('builds named header/body params from resolved values and freezes the header snapshot', () => {
    const row = mapped();
    const prepared = {
      template: { ...row, connectionId: 'connection', language: 'en' },
      context: {},
      mapping: validatePreparationMapping(row),
      resolvedVariables: {
        'contact.first_name': 'Guest',
        'property.name': 'RZ',
      },
    };
    const payload = buildMetaTemplateMessagePayload(prepared);
    expect(payload.components).toEqual([
      {
        type: 'header',
        parameters: [
          { type: 'text', text: 'Guest', parameter_name: 'recipient' },
        ],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Guest', parameter_name: 'guest' },
          { type: 'text', text: 'RZ', parameter_name: 'property' },
        ],
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain('APPROVAL');
    expect(
      buildTemplateMessageSnapshot(prepared.template, payload.components).header
    ).toEqual({ type: 'text', text: 'For Guest' });
    expect(renderTemplateBody(row.body_text, ['Guest', 'RZ'])).toBe(
      'Welcome to RZ, Guest. Hello Guest!'
    );
  });
  it('supports the generic send builder without treating a named template as static', () => {
    expect(
      buildSendComponents(imported(), {
        headerText: 'Guest',
        body: ['Guest', 'RZ'],
      })
    ).toEqual([
      {
        type: 'header',
        parameters: [
          { type: 'text', text: 'Guest', parameter_name: 'recipient' },
        ],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Guest', parameter_name: 'guest' },
          { type: 'text', text: 'RZ', parameter_name: 'property' },
        ],
      },
    ]);
    expect(() => buildSendComponents(imported())).toThrow();
  });
  it('rejects mismatched parameter metadata, mixed formats and incomplete mappings', () => {
    const row = mapped();
    row.semantic_variable_mapping![0].parameter_name = 'forged';
    expect(() => validatePreparationMapping(row)).toThrow();
    expect(() => extractTemplateVariables('Hi {{1}} {{guest}}')).toThrow();
    expect(() => extractTemplateVariables('Hi {{broken.name}}')).toThrow();
    expect(() => mapImportedTemplate(imported(), [], catalog)).toThrow();
    const mixed = mapped();
    mixed.header_content = 'For {{1}}';
    expect(() => validatePreparationMapping(mixed)).toThrow();
  });
  it('keeps RZ-authored templates positional and sparse rendering compatible', () => {
    const result = compileSemanticTemplate(
      { name: 'welcome', category: 'Utility', language: 'en', body_text: '' },
      { body_text: 'Hello {{contact.first_name}} at {{property.name}}.' },
      catalog
    );
    expect(result.transport.body_text).toBe('Hello {{1}} at {{2}}.');
    expect(
      result.metadata.semantic_variable_mapping.every((m) => !m.parameter_name)
    ).toBe(true);
    expect(renderTemplateBody('Hello {{2}}', ['one', 'two'])).toBe('Hello two');
  });
});
