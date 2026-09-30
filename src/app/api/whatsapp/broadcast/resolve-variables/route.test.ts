import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageContextError } from '@/lib/message-variables/context';
import type { MessageVariableMapping } from '@/lib/message-variables';

const state = vi.hoisted(() => ({
  accountId: 'workspace-b',
  template: {
    id: 'template-1',
    user_id: 'user-1',
    name: 'welcome',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Hi {{1}}',
    created_at: '2026-01-01T00:00:00Z',
  } as Record<string, unknown>,
  definitions: [] as Array<Record<string, unknown>>,
  buildAndResolve: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    supabase: {},
    accountId: state.accountId,
    userId: 'user-1',
  })),
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Internal server error' }, { status: 500 })
  ),
}));

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(async () => ({
    row: state.template,
    malformed: false,
    language: 'en_US',
  })),
}));

vi.mock('@/lib/message-variables', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/message-variables')>();
  return {
    ...original,
    listMessageVariableDefinitions: vi.fn(async () => state.definitions),
    buildAndResolveMessageVariables: (...args: unknown[]) =>
      state.buildAndResolve(...args),
  };
});

import { POST } from './route';

function definition(
  variableKey: string,
  sourceScope: 'contact' | 'reservation' | 'property' | 'workspace',
  isActive = true
) {
  return {
    id: variableKey,
    variableKey,
    label: variableKey,
    description: null,
    category: sourceScope,
    dataType: 'text',
    sourceScope,
    resolverKey: variableKey,
    previewValue: null,
    defaultFallback: null,
    isSensitive: false,
    isActive,
    sortOrder: 1,
  };
}

function request(body: Record<string, unknown>) {
  return new Request(
    'http://localhost/api/whatsapp/broadcast/resolve-variables',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_name: 'welcome',
        template_language: 'en_US',
        whatsapp_config_id: 'connection-1',
        ...body,
      }),
    }
  );
}

const catalogMapping = (
  variableKey: string,
  component: 'body' | 'header' = 'body',
  position = 1
): MessageVariableMapping => ({
  component,
  position,
  source_type: 'catalog_variable',
  variable_key: variableKey,
});

describe('Broadcast semantic resolver route', () => {
  beforeEach(() => {
    state.accountId = 'workspace-b';
    state.template = {
      id: 'template-1',
      user_id: 'user-1',
      name: 'welcome',
      category: 'Utility',
      language: 'en_US',
      body_text: 'Hi {{1}}',
      created_at: '2026-01-01T00:00:00Z',
    };
    state.definitions = [
      definition('contact.first_name', 'contact'),
      definition('contact.email', 'contact'),
      definition('workspace.name', 'workspace'),
      definition('reservation.check_in', 'reservation'),
      definition('property.wifi_name', 'property'),
      definition('contact.inactive', 'contact', false),
    ];
    state.buildAndResolve.mockReset();
    state.buildAndResolve.mockImplementation(
      async (input: {
        accountId: string;
        contactId?: string;
        mappings: MessageVariableMapping[];
      }) => {
        if (input.contactId === 'contact-from-workspace-a') {
          throw new MessageContextError(
            'entity_not_found',
            'Contact not found in this workspace.'
          );
        }
        const crossAccountField = input.mappings.find(
          (mapping) =>
            mapping.source_type === 'custom_field' &&
            mapping.custom_field_id === 'field-from-workspace-a'
        );
        if (
          crossAccountField &&
          crossAccountField.source_type === 'custom_field'
        ) {
          return {
            success: false,
            values: [],
            missing: [],
            errors: [
              {
                code: 'CUSTOM_FIELD_NOT_FOUND',
                mapping_index: 0,
                component: crossAccountField.component,
                position: crossAccountField.position,
                custom_field_id: crossAccountField.custom_field_id,
              },
            ],
          };
        }
        if (!input.contactId) {
          return { success: false, values: [], missing: [], errors: [] };
        }
        const missing = input.mappings.find(
          (mapping) =>
            mapping.source_type === 'catalog_variable' &&
            mapping.variable_key === 'contact.email'
        );
        if (missing && missing.source_type === 'catalog_variable') {
          return {
            success: false,
            values: [],
            missing: [
              {
                component: missing.component,
                position: missing.position,
                source_type: missing.source_type,
                variable_key: missing.variable_key,
                reason: 'MISSING_CONTEXT_VALUE',
              },
            ],
            errors: [],
          };
        }
        return {
          success: true,
          values: input.mappings.map((mapping) => ({
            component: mapping.component,
            position: mapping.position,
            source_type: mapping.source_type,
            value:
              mapping.source_type === 'static'
                ? mapping.static_value
                : mapping.source_type === 'catalog_variable' &&
                    mapping.variable_key === 'workspace.name'
                  ? 'Workspace B'
                  : 'Ada',
            ...(mapping.source_type === 'catalog_variable'
              ? { variable_key: mapping.variable_key }
              : {}),
          })),
          missing: [],
          errors: [],
        };
      }
    );
  });

  it('uses the authenticated active account and ignores browser account_id', async () => {
    const response = await POST(
      request({
        account_id: 'workspace-a',
        contact_ids: ['contact-b'],
        mappings: [catalogMapping('contact.first_name')],
      })
    );

    expect(response.status).toBe(200);
    expect(state.buildAndResolve).toHaveBeenCalled();
    for (const [input] of state.buildAndResolve.mock.calls) {
      expect(input).toMatchObject({ accountId: 'workspace-b' });
      expect(input).not.toHaveProperty('accountId', 'workspace-a');
    }
  });

  it('rejects a contact from another account', async () => {
    const response = await POST(
      request({
        contact_ids: ['contact-from-workspace-a'],
        mappings: [catalogMapping('contact.first_name')],
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'One or more contacts are not available in this workspace.',
    });
  });

  it('rejects a custom field from another account', async () => {
    const response = await POST(
      request({
        validate_only: true,
        mappings: [
          {
            component: 'body',
            position: 1,
            source_type: 'custom_field',
            custom_field_id: 'field-from-workspace-a',
          },
        ],
      })
    );
    expect(response.status).toBe(400);
  });

  it('resolves contact and workspace semantic variables', async () => {
    state.template.body_text = 'Hi {{1}} from {{2}}';
    const response = await POST(
      request({
        contact_ids: ['contact-b'],
        mappings: [
          catalogMapping('contact.first_name', 'body', 1),
          catalogMapping('workspace.name', 'body', 2),
        ],
      })
    );
    expect(await response.json()).toMatchObject({
      results: [
        {
          success: true,
          message_params: { body: ['Ada', 'Workspace B'] },
        },
      ],
    });
  });

  it('returns an identity-only recipient failure for a missing required value', async () => {
    const response = await POST(
      request({
        contact_ids: ['contact-b'],
        mappings: [catalogMapping('contact.email')],
      })
    );
    expect(await response.json()).toMatchObject({
      results: [
        {
          success: false,
          error: 'BODY {{1}}: contact.email is missing',
        },
      ],
    });
  });

  it('rejects inactive and context-unavailable variables', async () => {
    for (const key of [
      'contact.inactive',
      'reservation.check_in',
      'property.wifi_name',
    ]) {
      const response = await POST(
        request({
          validate_only: true,
          mappings: [catalogMapping(key)],
        })
      );
      expect(response.status).toBe(400);
    }
  });

  it('returns structured frozen BODY and TEXT HEADER messageParams', async () => {
    state.template.header_type = 'text';
    state.template.header_content = 'Welcome {{1}}';
    state.template.body_text = 'Hi {{1}} from {{2}}';
    const response = await POST(
      request({
        contact_ids: ['contact-b'],
        mappings: [
          catalogMapping('workspace.name', 'header', 1),
          catalogMapping('contact.first_name', 'body', 1),
          catalogMapping('workspace.name', 'body', 2),
        ],
      })
    );
    expect(await response.json()).toMatchObject({
      results: [
        {
          message_params: {
            headerText: 'Workspace B',
            body: ['Ada', 'Workspace B'],
          },
        },
      ],
    });
  });
});
