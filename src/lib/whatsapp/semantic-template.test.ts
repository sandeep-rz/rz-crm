import { describe, it, expect } from 'vitest';
import {
  compileSemanticTemplate,
  renderSemanticText,
  semanticSegments,
  mapImportedTemplate,
  importedMetadata,
  reconcileTemplateSemantics,
  canMapImportedTemplate,
  type CatalogVariable,
} from './semantic-template';
import { buildMetaTemplatePayload } from './template-components';
import type { MessageTemplate } from '@/types';
import { validatePreparationMapping } from '@/lib/message-preparation/mapping';
import { semanticTemplateIsUsable } from '@/lib/automations/semantic-template-action';
import { semanticBroadcastTemplateIssue } from '@/lib/broadcast-message-variables';
const catalog: CatalogVariable[] = [
  {
    variableKey: 'contact.first_name',
    label: 'Contact first name',
    previewValue: 'Sandeep',
    isActive: true,
    category: 'contact',
    sortOrder: 10,
  },
  {
    variableKey: 'property.name',
    label: 'Property name',
    previewValue: 'Lakeside Meadows',
    isActive: true,
    category: 'property',
    sortOrder: 300,
  },
  {
    variableKey: 'listing.check_in_time',
    label: 'Check-in time',
    previewValue: '14:00',
    isActive: true,
    category: 'listing',
    sortOrder: 510,
  },
];
const payload = {
  name: 'confirmation',
  category: 'Utility' as const,
  language: 'en_US',
  body_text: 'ignored transport',
};
const imported = {
  template_origin: 'meta',
  variable_configuration_status: 'needs_mapping',
  id: 'id',
  name: 'legacy',
  body_text: 'Hi {{1}} at {{2}}',
  sample_values: { body: ['Original', 'Sample'] },
  status: 'APPROVED',
  meta_template_id: 'meta',
  user_id: 'u',
  created_at: 'now',
} as MessageTemplate;
describe('semantic template authoring and compilation', () => {
  it('keeps canonical token identity separately from the exact dynamic label', () => {
    const text = 'Hi {{contact.first_name}}';
    expect(semanticSegments(text)[1].variableKey).toBe('contact.first_name');
    expect(renderSemanticText(text, catalog, 'label')).toBe(
      'Hi {{Contact first name}}'
    );
    expect(
      renderSemanticText(
        text,
        [{ ...catalog[0], label: 'Updated contact name' }],
        'label'
      )
    ).toBe('Hi {{Updated contact name}}');
    expect(text).toBe('Hi {{contact.first_name}}');
  });
  it('compiles left to right with catalog samples and provider-neutral variables', () => {
    const content = {
      body_text:
        'Hi {{contact.first_name}} at {{property.name}} at {{listing.check_in_time}}',
    };
    const result = compileSemanticTemplate(payload, content, catalog);
    expect(result.transport.body_text).toBe('Hi {{1}} at {{2}} at {{3}}');
    expect(result.metadata.semantic_content).toEqual(content);
    expect(
      result.metadata.semantic_variable_mapping.map((m) => [
        m.position,
        m.variable_key,
      ])
    ).toEqual([
      [1, 'contact.first_name'],
      [2, 'property.name'],
      [3, 'listing.check_in_time'],
    ]);
    expect(result.transport.sample_values?.body).toEqual([
      'Sandeep',
      'Lakeside Meadows',
      '14:00',
    ]);
    expect(renderSemanticText(content.body_text, catalog, 'preview')).toBe(
      'Hi Sandeep at Lakeside Meadows at 14:00'
    );
    expect(
      JSON.stringify(buildMetaTemplatePayload(result.transport))
    ).not.toContain('contact.first_name');
    expect(
      buildMetaTemplatePayload(result.transport).components[0].example
        ?.body_text
    ).toEqual([['Sandeep', 'Lakeside Meadows', '14:00']]);
  });
  it('assigns independent positions to repeated occurrences', () => {
    const result = compileSemanticTemplate(
      payload,
      {
        body_text: 'Hi {{contact.first_name}}. Thanks {{contact.first_name}}.',
      },
      catalog
    );
    expect(result.transport.body_text).toBe('Hi {{1}}. Thanks {{2}}.');
    expect(
      result.metadata.semantic_variable_mapping.map((m) => m.variable_key)
    ).toEqual(['contact.first_name', 'contact.first_name']);
  });
  it('scopes numbering to header, body and each URL button', () => {
    const result = compileSemanticTemplate(
      {
        ...payload,
        header_type: 'text',
        buttons: [{ type: 'URL', text: 'View', url: 'https://example.com/x' }],
      },
      {
        header_content: 'Hello {{contact.first_name}}',
        body_text: 'Stay at {{property.name}}',
        button_urls: { '0': 'https://example.com/{{contact.first_name}}' },
      },
      catalog
    );
    expect(result.transport.header_content).toBe('Hello {{1}}');
    expect(result.transport.body_text).toBe('Stay at {{1}}');
    expect(
      result.metadata.semantic_variable_mapping.map((m) => [
        m.component,
        m.button_index,
        m.position,
      ])
    ).toEqual([
      ['HEADER', undefined, 1],
      ['BODY', undefined, 1],
      ['BUTTON', 0, 1],
    ]);
    expect(result.transport.buttons?.[0]).toMatchObject({
      url: 'https://example.com/{{1}}',
      example: 'https://example.com/Sandeep',
    });
  });
  it.each([
    'Hi {{whatever}}',
    'Hi {{Contact first name}}',
    'Hi {{1}}',
    'Hi {{contact.first_name}',
    'Hi contact.first_name}}',
  ])('rejects unsupported or malformed token %s', (body_text) =>
    expect(() =>
      compileSemanticTemplate(payload, { body_text }, catalog)
    ).toThrow()
  );
  it('rejects inactive variables and absent approval samples', () => {
    for (const entry of [
      { ...catalog[0], isActive: false },
      { ...catalog[0], previewValue: null },
    ])
      expect(() =>
        compileSemanticTemplate(
          payload,
          { body_text: 'Hi {{contact.first_name}}' },
          [entry]
        )
      ).toThrow();
  });
  it('preserves Meta component limits and rejects footer/label tokens', () => {
    expect(() =>
      compileSemanticTemplate(
        { ...payload, header_type: 'text' },
        {
          body_text: 'Hello',
          header_content: '{{contact.first_name}} {{property.name}}',
        },
        catalog
      )
    ).toThrow('at most one');
    expect(() =>
      compileSemanticTemplate(
        { ...payload, footer_text: '{{contact.first_name}}' },
        { body_text: 'Hello' },
        catalog
      )
    ).toThrow('Footer');
  });
  it('does not guess imported positional meanings or conflate approval status', () => {
    expect(importedMetadata(imported)).toEqual({
      template_origin: 'meta',
      semantic_content: null,
      semantic_variable_mapping: [],
      variable_configuration_status: 'needs_mapping',
    });
    expect(imported.status).toBe('APPROVED');
  });
  it('manually maps imported positions, retaining original transport and approval samples', () => {
    const mapped = mapImportedTemplate(
      imported,
      [
        { component: 'BODY', position: 1, variable_key: 'contact.first_name' },
        { component: 'BODY', position: 2, variable_key: 'property.name' },
      ],
      catalog
    );
    expect(mapped.semantic_content?.body_text).toBe(
      'Hi {{contact.first_name}} at {{property.name}}'
    );
    expect(mapped.semantic_variable_mapping[0].sample).toBe('Original');
    expect(imported.body_text).toBe('Hi {{1}} at {{2}}');
    expect(imported.meta_template_id).toBe('meta');
    expect(() => mapImportedTemplate(imported, [], catalog)).toThrow();
  });
  it('preserves mapped semantics on unchanged sync and invalidates changed Meta text', () => {
    const mapped = {
      ...imported,
      ...mapImportedTemplate(
        imported,
        [
          {
            component: 'BODY',
            position: 1,
            variable_key: 'contact.first_name',
          },
          { component: 'BODY', position: 2, variable_key: 'property.name' },
        ],
        catalog
      ),
    };
    expect(
      reconcileTemplateSemantics(mapped, imported).semantic_content
    ).toEqual(mapped.semantic_content);
    expect(
      reconcileTemplateSemantics(mapped, {
        ...imported,
        body_text: 'Different {{1}}',
      }).variable_configuration_status
    ).toBe('needs_mapping');
  });
  it('allows mapping only for imported templates requiring mapping', () => {
    expect(canMapImportedTemplate(imported)).toBe(true);
    expect(
      canMapImportedTemplate({ ...imported, template_origin: 'rgcrm' })
    ).toBe(false);
    expect(
      canMapImportedTemplate({
        ...imported,
        variable_configuration_status: 'configured',
      })
    ).toBe(false);
    expect(() =>
      mapImportedTemplate(
        { ...imported, template_origin: 'rgcrm' },
        [],
        catalog
      )
    ).toThrow('only available');
  });
  it('retains authoritative RGCRM semantics on sync and rejects changed remote transport', () => {
    const compiled = compileSemanticTemplate(
      payload,
      { body_text: 'Hello {{contact.first_name}}' },
      catalog
    );
    const created = {
      ...imported,
      ...compiled.transport,
      ...compiled.metadata,
    };
    expect(reconcileTemplateSemantics(created, created)).toEqual(
      compiled.metadata
    );
    expect(() =>
      reconcileTemplateSemantics(created, {
        ...created,
        body_text: 'Changed {{1}}',
      })
    ).toThrow('authoritative');
    expect(canMapImportedTemplate(created)).toBe(false);
  });
  it('requires URL content to come from semantic content, not transport fields', () => {
    expect(() =>
      compileSemanticTemplate(
        {
          ...payload,
          buttons: [
            { type: 'URL', text: 'Open', url: 'https://example.com/transport' },
          ],
        },
        { body_text: 'Hello' },
        catalog
      )
    ).toThrow('Semantic component');
  });
  it('imports static Meta templates configured without invented variables', () =>
    expect(
      importedMetadata({ ...imported, body_text: 'Welcome' })
        .variable_configuration_status
    ).toBe('configured'));
});

describe('static imported template configuration', () => {
  const staticTemplate = (extras: Partial<MessageTemplate> = {}) => ({
    ...imported,
    body_text: 'Thank you for contacting us.',
    whatsapp_config_id: 'connection',
    language: 'en_US',
    ...extras,
  });
  it.each([
    {},
    { header_type: 'text', header_content: 'Welcome' },
    {
      buttons: [
        { type: 'QUICK_REPLY', text: 'Thanks' },
        { type: 'URL', text: 'Visit', url: 'https://example.test/help' },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+14155550123' },
      ],
    },
    {
      header_type: 'image',
      header_media_url: 'https://example.test/welcome.jpg',
    },
  ] as Partial<MessageTemplate>[])(
    'stores canonical static content without fabricated variables: %j',
    (extras) => {
      const transport = staticTemplate(extras);
      const template = { ...transport, ...importedMetadata(transport) };
      expect(template.variable_configuration_status).toBe('configured');
      expect(template.semantic_variable_mapping).toEqual([]);
      expect(template.semantic_content?.body_text).toBe(transport.body_text);
      expect(validatePreparationMapping(template)).toEqual([]);
      expect(semanticTemplateIsUsable(template, 'connection')).toBe(true);
      expect(semanticBroadcastTemplateIssue(template, [])).toBeNull();
      expect(canMapImportedTemplate(template)).toBe(false);
      expect(
        renderSemanticText(template.semantic_content!.body_text, [], 'label')
      ).toBe(transport.body_text);
      if (extras.header_type === 'text')
        expect(template.semantic_content?.header_content).toBe('Welcome');
      if (extras.buttons)
        expect(template.semantic_content?.button_urls).toEqual({
          '1': 'https://example.test/help',
        });
    }
  );
  it.each([
    { body_text: 'Hello {{1}}, thank you for getting in touch with us.' },
    { header_type: 'text', header_content: 'Hello {{1}}' },
    {
      buttons: [
        { type: 'URL', text: 'Visit', url: 'https://example.test/{{1}}' },
      ],
    },
    { body_text: 'Hello {{name}}' },
  ] as Partial<MessageTemplate>[])(
    'keeps dynamic imports unmapped and rejects an empty mapping bypass: %j',
    (extras) => {
      const transport = staticTemplate(extras);
      const metadata = importedMetadata(transport);
      expect(metadata).toMatchObject({
        variable_configuration_status: 'needs_mapping',
        semantic_content: null,
        semantic_variable_mapping: [],
      });
      expect(() =>
        validatePreparationMapping({ ...transport, ...metadata })
      ).toThrow();
    }
  );
  it.each(['needs_mapping', 'configured'] as const)(
    'repairs existing static %s metadata on unchanged sync',
    (status) => {
      const transport = staticTemplate();
      const existing = {
        ...transport,
        semantic_content: null,
        semantic_variable_mapping: [],
        variable_configuration_status: status,
      };
      expect(reconcileTemplateSemantics(existing, transport)).toEqual(
        importedMetadata(transport)
      );
    }
  );
});
