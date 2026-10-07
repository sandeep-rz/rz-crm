import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';
import { compileSemanticTemplate } from '@/lib/whatsapp/semantic-template';
import { resolveRuntimeVariables } from '@/lib/message-variables/runtime-resolver';
import { prepareTemplateMessage } from './prepare-template-message';
import {
  buildMetaTemplateComponents,
  buildMetaTemplateMessagePayload,
} from '@/lib/whatsapp/meta-template-payload';
vi.mock('server-only', () => ({}));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = {
  accountId: id(1),
  templateId: id(2),
  context: { reservationId: id(3) },
};
const catalog = [
  'contact.first_name',
  'property.name',
  'reservation.check_in_date',
  'listing.check_in_time',
  'workspace.name',
].map((variableKey) => ({
  variableKey,
  label: variableKey,
  previewValue: 'APPROVAL_ONLY',
  isActive: true,
  category: 'contact' as const,
  sortOrder: 0,
}));
let template: MessageTemplate;
let connection: Record<string, unknown> | null;
let failDb = false;
let ignoreFilters = false;
let reads: string[];
const db = {
  from(table: string) {
    reads.push(table);
    const filters: [string, unknown][] = [];
    const query = {
      select: () => query,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return query;
      },
      maybeSingle: async () => {
        const row = table === 'message_templates' ? template : connection;
        return {
          data:
            row &&
            (ignoreFilters ||
              filters.every(
                ([k, v]) => (row as unknown as Record<string, unknown>)[k] === v
              ))
              ? row
              : null,
          error: failDb ? { message: 'PRIVATE_DATABASE_BODY' } : null,
        };
      },
    };
    return query;
  },
} as unknown as SupabaseClient;
const resolver = vi.fn<typeof resolveRuntimeVariables>();
const run = () =>
  prepareTemplateMessage(input, { db, resolveVariables: resolver });
function author(body: string, extras: Partial<TemplatePayload> = {}) {
  const { transport, metadata } = compileSemanticTemplate(
    {
      name: 'booking_confirmed',
      category: 'Utility',
      language: 'en_US',
      body_text: '',
      ...extras,
    },
    {
      body_text: body,
      ...(extras.header_type === 'text'
        ? { header_content: extras.header_content }
        : {}),
      button_urls: Object.fromEntries(
        (extras.buttons ?? []).flatMap((b, i) =>
          b.type === 'URL' ? [[String(i), b.url]] : []
        )
      ),
    },
    catalog
  );
  template = {
    ...transport,
    ...metadata,
    id: id(2),
    account_id: id(1),
    user_id: id(7),
    whatsapp_config_id: id(4),
    status: 'APPROVED',
    meta_template_id: 'meta-id',
    created_at: '',
  };
}
beforeEach(() => {
  reads = [];
  failDb = false;
  ignoreFilters = false;
  connection = { id: id(4), account_id: id(1) };
  author('Hello {{contact.first_name}}, your booking is confirmed.');
  resolver.mockReset().mockImplementation(async (request) => ({
    success: true,
    contractVersion: 'v1',
    invalidKeys: [],
    failures: [],
    values: Object.fromEntries(
      [...request.variableKeys].reverse().map((key) => [
        key,
        {
          status: 'resolved',
          value:
            key === 'contact.first_name'
              ? 'Sandeep'
              : key === 'property.name'
                ? 'Lombara Homestay'
                : key === 'reservation.check_in_date'
                  ? '15 Oct 2026'
                  : key === 'listing.check_in_time'
                    ? '2:00 PM'
                    : 'Workspace',
          source: key === 'workspace.name' ? 'crm' : 'provider',
        },
      ])
    ),
  }));
});
describe('central preparation', () => {
  it('prepares a no-variable semantic template with one empty runtime operation', async () => {
    author('Your booking is confirmed.');
    const prepared = await run();
    expect(prepared.resolvedVariables).toEqual({});
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0].variableKeys).toEqual([]);
    expect(buildMetaTemplateComponents(prepared)).toEqual([]);
  });
  it('prepares one body variable', async () => {
    expect((await run()).resolvedVariables).toEqual({
      'contact.first_name': 'Sandeep',
    });
  });
  it('produces the realistic four ordered Meta parameters through the Step 3 compiler', async () => {
    author(
      'Hi {{contact.first_name}},\nYour booking at {{property.name}} is confirmed.\nCheck-in: {{reservation.check_in_date}} at {{listing.check_in_time}}.'
    );
    const p = await run();
    expect(buildMetaTemplateMessagePayload(p)).toEqual({
      name: 'booking_confirmed',
      language: { code: 'en_US' },
      components: [
        {
          type: 'body',
          parameters: [
            'Sandeep',
            'Lombara Homestay',
            '15 Oct 2026',
            '2:00 PM',
          ].map((text) => ({ type: 'text', text })),
        },
      ],
    });
  });
  it('resolves unique keys once and preserves repeated occurrences', async () => {
    author(
      'Hi {{contact.first_name}}, {{property.name}} welcomes {{contact.first_name}}.'
    );
    const p = await run();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0].variableKeys).toEqual([
      'contact.first_name',
      'property.name',
    ]);
    expect(buildMetaTemplateComponents(p)[0].parameters).toEqual(
      ['Sandeep', 'Lombara Homestay', 'Sandeep'].map((text) => ({
        type: 'text',
        text,
      }))
    );
  });
  it('merges CRM and provider values only through Step 4', async () => {
    author(
      '{{workspace.name}} welcomes {{contact.first_name}} to your confirmed booking.'
    );
    expect((await run()).resolvedVariables).toEqual({
      'workspace.name': 'Workspace',
      'contact.first_name': 'Sandeep',
    });
    expect(reads).toEqual(['message_templates', 'whatsapp_config']);
  });
  it.each(['missing', 'unsupported'] as const)(
    'blocks %s without sample/default fallback',
    async (status) => {
      resolver.mockResolvedValue({
        success: true,
        contractVersion: 'v1',
        invalidKeys: [],
        failures: [],
        values: {
          'contact.first_name': { status, value: null, source: 'provider' },
        },
      });
      await expect(run()).rejects.toMatchObject({
        code: `variable_${status}`,
        diagnostics: { variableKey: 'contact.first_name' },
        retryable: false,
      });
    }
  );
  it('preserves provider failure classification and safe diagnostics', async () => {
    resolver.mockResolvedValue({
      success: false,
      contractVersion: 'v1',
      invalidKeys: [],
      values: {},
      failures: [
        {
          code: 'upstream_temporary',
          source: 'provider',
          variableKeys: ['contact.first_name'],
          retryable: true,
          httpStatus: 500,
          providerCode: 'internal_error',
        },
      ],
    });
    await expect(run()).rejects.toMatchObject({
      code: 'runtime_provider_failure',
      retryable: true,
      diagnostics: {
        runtimeFailures: [
          expect.objectContaining({
            httpStatus: 500,
            providerCode: 'internal_error',
          }),
        ],
      },
    });
  });
  it('keeps authentication failure nonretryable', async () => {
    resolver.mockResolvedValue({
      success: false,
      contractVersion: 'v1',
      invalidKeys: [],
      values: {},
      failures: [
        {
          code: 'authentication',
          source: 'provider',
          variableKeys: ['contact.first_name'],
          retryable: false,
        },
      ],
    });
    await expect(run()).rejects.toMatchObject({
      code: 'runtime_provider_failure',
      retryable: false,
    });
  });
  it('classifies catalog/context resolution failure separately', async () => {
    resolver.mockResolvedValue({
      success: false,
      contractVersion: 'v1',
      invalidKeys: ['contact.first_name'],
      values: {},
      failures: [
        {
          code: 'invalid_variables',
          source: 'catalog',
          variableKeys: ['contact.first_name'],
          retryable: false,
        },
      ],
    });
    await expect(run()).rejects.toMatchObject({
      code: 'runtime_resolution_failure',
    });
  });
  it('sanitizes thrown runtime exceptions', async () => {
    resolver.mockRejectedValue(new Error('PRIVATE_PASSWORD'));
    await expect(run()).rejects.toMatchObject({
      message: 'runtime_resolution_failure',
    });
  });
  it('never copies approval sample, preview or fallback fields to the result', async () => {
    Object.assign(template, {
      preview_value: 'PREVIEW_SECRET',
      default_fallback: 'FALLBACK_SECRET',
    });
    template.sample_values = { body: ['APPROVAL_SECRET'] };
    template.buttons = [
      Object.assign(
        { type: 'QUICK_REPLY' as const, text: 'OK' },
        { example: 'APPROVAL_SECRET' }
      ),
    ];
    const p = await run();
    const serialized = JSON.stringify(p);
    for (const forbidden of [
      'APPROVAL_ONLY',
      'PREVIEW_SECRET',
      'FALLBACK_SECRET',
      'APPROVAL_SECRET',
      'sample',
    ])
      expect(serialized).not.toContain(forbidden);
  });
  it.each(['0', '', '   ', '  unchanged  '])(
    'preserves the exact resolved string %j',
    async (text) => {
      resolver.mockResolvedValue({
        success: true,
        contractVersion: 'v1',
        invalidKeys: [],
        failures: [],
        values: {
          'contact.first_name': {
            status: 'resolved',
            value: text,
            source: 'provider',
          },
        },
      });
      expect(buildMetaTemplateComponents(await run())[0].parameters).toEqual([
        { type: 'text', text },
      ]);
    }
  );
  it('rejects needs_mapping before runtime I/O', async () => {
    template.variable_configuration_status = 'needs_mapping';
    await expect(run()).rejects.toMatchObject({
      code: 'template_not_configured',
    });
    expect(resolver).not.toHaveBeenCalled();
  });
  it('enforces account ownership', async () => {
    template.account_id = id(8);
    await expect(run()).rejects.toMatchObject({ code: 'template_not_owned' });
    expect(resolver).not.toHaveBeenCalled();
  });
  it('rejects ownership mismatch even if a query ignores filters', async () => {
    ignoreFilters = true;
    template.account_id = id(8);
    await expect(run()).rejects.toMatchObject({ code: 'template_not_owned' });
  });
  it('distinguishes missing template', async () => {
    template.id = id(8);
    await expect(run()).rejects.toMatchObject({ code: 'template_not_found' });
  });
  it('sanitizes database failures', async () => {
    failDb = true;
    await expect(run()).rejects.toMatchObject({
      code: 'template_lookup_failed',
      message: 'template_lookup_failed',
    });
  });
  it.each([null, { id: id(4), account_id: id(8) }])(
    'enforces connection ownership %j',
    async (row) => {
      connection = row;
      await expect(run()).rejects.toMatchObject({
        code: 'template_connection_invalid',
      });
    }
  );
  it.each(['PENDING', 'PAUSED', 'DISABLED'] as const)(
    'rejects transport status %s',
    async (status) => {
      template.status = status;
      await expect(run()).rejects.toMatchObject({
        code: 'template_not_sendable',
      });
    }
  );
  it('requires synchronized transport identity', async () => {
    template.meta_template_id = undefined;
    await expect(run()).rejects.toMatchObject({
      code: 'template_not_sendable',
    });
  });
  it.each([
    'resolvedVariables',
    'provider',
    'source_type',
    'source_record_id',
    'property_id',
  ])('rejects caller field %s', async (field) => {
    await expect(
      prepareTemplateMessage({ ...input, [field]: 'FORGED' } as typeof input, {
        db,
        resolveVariables: resolver,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      prepareTemplateMessage(
        {
          ...input,
          context: { ...input.context, [field]: 'FORGED' },
        } as typeof input,
        { db, resolveVariables: resolver }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it.each([
    null,
    {},
    [{ component: 'BODY', position: 0, variable_key: 'contact.first_name' }],
    [{ component: 'BODY', position: 1.5, variable_key: 'contact.first_name' }],
    [{ component: 'BODY', position: 1, variable_key: 'Contact first name' }],
    [],
    [{ component: 'BODY', position: 2, variable_key: 'contact.first_name' }],
    [
      { component: 'BODY', position: 1, variable_key: 'contact.first_name' },
      { component: 'BODY', position: 1, variable_key: 'contact.first_name' },
    ],
    [
      {
        component: 'BODY',
        position: 1,
        button_index: 0,
        variable_key: 'contact.first_name',
      },
    ],
  ])('rejects invalid persisted mapping %j', async (mapping) => {
    Object.assign(template, { semantic_variable_mapping: mapping });
    await expect(run()).rejects.toMatchObject({
      code: 'invalid_semantic_mapping',
    });
    expect(resolver).not.toHaveBeenCalled();
  });
  it('rejects semantic content/mapping drift', async () => {
    template.semantic_variable_mapping![0].variable_key = 'property.name';
    await expect(run()).rejects.toMatchObject({
      code: 'invalid_semantic_mapping',
    });
  });
  it('supports configured manually mapped imports without recompiling their repeated positional token', async () => {
    template.template_origin = 'meta';
    template.body_text = 'Hi {{1}}, welcome {{1}}.';
    template.semantic_content = {
      body_text: 'Hi {{contact.first_name}}, welcome {{contact.first_name}}.',
    };
    expect(buildMetaTemplateComponents(await run())[0].parameters).toEqual([
      { type: 'text', text: 'Sandeep' },
    ]);
  });
  it('never logs values or objects', async () => {
    const spies = ['log', 'info', 'warn', 'error'].map((k) =>
      vi.spyOn(console, k as 'log').mockImplementation(() => {})
    );
    try {
      buildMetaTemplateMessagePayload(await run());
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
describe('Meta components', () => {
  it('sorts positions above nine numerically', async () => {
    author(
      'Your confirmed booking details: ' +
        Array.from({ length: 12 }, () => '{{contact.first_name}}').join(' and ')
    );
    const p = await run();
    p.mapping.forEach((m, i) => {
      m.variable_key = `contact.value_${i + 1}`;
      p.resolvedVariables[m.variable_key] = String(i + 1);
    });
    p.mapping.reverse();
    expect(buildMetaTemplateComponents(p)[0].parameters).toEqual(
      Array.from({ length: 12 }, (_, i) => ({
        type: 'text',
        text: String(i + 1),
      }))
    );
  });

  it('sorts BODY slots numerically regardless of mapping/response order', async () => {
    author('Hello {{contact.first_name}}, welcome to {{property.name}}.');
    template.semantic_variable_mapping!.reverse();
    expect(buildMetaTemplateComponents(await run())[0].parameters).toEqual([
      { type: 'text', text: 'Sandeep' },
      { type: 'text', text: 'Lombara Homestay' },
    ]);
  });
  it('assembles HEADER and BODY independently', async () => {
    author('Hello {{contact.first_name}}, your booking is confirmed.', {
      header_type: 'text',
      header_content: 'Welcome {{property.name}}',
    });
    expect(
      buildMetaTemplateComponents(await run()).map((c) => [
        c.type,
        c.parameters,
      ])
    ).toEqual([
      ['header', [{ type: 'text', text: 'Lombara Homestay' }]],
      ['body', [{ type: 'text', text: 'Sandeep' }]],
    ]);
  });
  it('preserves zero-based URL indexes across static buttons and two dynamic buttons', async () => {
    author('Hello {{contact.first_name}}, view your confirmed booking.', {
      buttons: [
        { type: 'QUICK_REPLY', text: 'OK' },
        {
          type: 'URL',
          text: 'Property',
          url: 'https://example.com/{{property.name}}',
        },
        {
          type: 'URL',
          text: 'Contact',
          url: 'https://example.com/{{contact.first_name}}',
        },
      ],
    });
    const p = await run();
    p.mapping.reverse();
    expect(buildMetaTemplateComponents(p).slice(1)).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '1',
        parameters: [{ type: 'text', text: 'Lombara Homestay' }],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '2',
        parameters: [{ type: 'text', text: 'Sandeep' }],
      },
    ]);
  });
  it.each([-1, 99, 0.5])('rejects invalid button index %s', async (index) => {
    template.semantic_variable_mapping![0] = {
      component: 'BUTTON',
      button_index: index,
      position: 1,
      variable_key: 'contact.first_name',
      sample: '',
    };
    await expect(run()).rejects.toMatchObject({
      code: 'invalid_semantic_mapping',
    });
  });
  it('rejects unsupported mapping component explicitly', async () => {
    Object.assign(template.semantic_variable_mapping![0], {
      component: 'FOOTER',
    });
    await expect(run()).rejects.toMatchObject({
      code: 'unsupported_template_component',
    });
  });
  it('rejects copy-code approval fallback', async () => {
    template.buttons = [
      { type: 'COPY_CODE', text: 'Copy', example: 'PRIVATE_SAMPLE' },
    ];
    await expect(run()).rejects.toMatchObject({
      code: 'unsupported_template_component',
    });
  });
  it.each([undefined, 123, false])(
    'rejects missing/nonstring prepared values %j',
    async (value) => {
      const p = await run();
      Object.assign(p.resolvedVariables, { 'contact.first_name': value });
      expect(() => buildMetaTemplateComponents(p)).toThrowError(
        expect.objectContaining({ code: 'provider_payload_invalid' })
      );
    }
  );
  it('rejects tampered mapping before payload assembly', async () => {
    const p = await run();
    p.mapping = [];
    expect(() => buildMetaTemplateComponents(p)).toThrowError(
      expect.objectContaining({ code: 'invalid_semantic_mapping' })
    );
  });
  it('assembles stored static media without using approval handles', async () => {
    template.header_type = 'image';
    template.header_media_url = 'https://example.com/header.jpg';
    template.header_handle = 'APPROVAL_ONLY';
    expect(buildMetaTemplateComponents(await run())[0]).toEqual({
      type: 'header',
      parameters: [
        { type: 'image', image: { link: 'https://example.com/header.jpg' } },
      ],
    });
  });
  it('fails static media without a reusable runtime link', async () => {
    template.header_type = 'image';
    template.header_handle = 'APPROVAL_ONLY';
    expect(() =>
      buildMetaTemplateComponents({
        template: {
          id: id(2),
          connectionId: id(4),
          name: 'static',
          language: 'en_US',
          body_text: 'Static',
          header_type: 'image',
        },
        context: input.context,
        mapping: [],
        resolvedVariables: {},
      })
    ).toThrowError(
      expect.objectContaining({ code: 'provider_payload_invalid' })
    );
  });
});
