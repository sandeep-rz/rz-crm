import { beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  writes: [] as Record<string, unknown>[],
  existing: null as Record<string, unknown> | null,
}));
const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  edit: vi.fn(),
  role: vi.fn(),
  catalog: vi.fn(),
}));
const db = {
  from: (table: string) => {
    if (table.startsWith('pms_')) throw new Error('No PMS integration exists');
    let write: Record<string, unknown> | undefined;
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: state.existing, error: null }),
      update: (row: Record<string, unknown>) => {
        write = row;
        state.writes.push(row);
        return q;
      },
      insert: (row: Record<string, unknown>) => {
        write = row;
        state.writes.push(row);
        return q;
      },
      single: async () => ({ data: { id: 'saved', ...write }, error: null }),
    };
    return q;
  },
};
vi.mock('@/lib/auth/account', async (original) => ({
  ...(await original<object>()),
  requireRole: mocks.role,
}));
vi.mock('@/lib/message-variables/catalog', () => ({
  listMessageVariableDefinitions: mocks.catalog,
}));
vi.mock('@/lib/whatsapp/connection-resolver', () => ({
  resolveWhatsAppConnection: async () => ({
    id: 'connection',
    wabaId: 'waba',
    accessToken: 'token',
  }),
}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<object>()),
  submitMessageTemplate: mocks.submit,
  editMessageTemplate: mocks.edit,
}));
vi.mock('@/lib/whatsapp/template-header-handle', () => ({
  ensureMediaHeaderHandle: async () => {},
}));
import { POST } from './route';
import { PATCH } from '../[id]/route';
import { PATCH as mapVariables } from '../[id]/variables/route';
const semantic = {
  name: 'welcome',
  category: 'Utility',
  language: 'en_US',
  body_text: 'ignored',
  semantic_content: { body_text: 'Hi {{contact.first_name}}.' },
};
const request = (body: unknown) =>
  new Request('http://localhost/api/whatsapp/templates/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  state.writes = [];
  state.existing = null;
  vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'false');
  mocks.role.mockResolvedValue({
    supabase: db,
    accountId: 'account',
    userId: 'user',
  });
  mocks.submit.mockResolvedValue({ id: 'meta-id', status: 'PENDING' });
  mocks.edit.mockResolvedValue({ success: true });
  mocks.catalog.mockResolvedValue([
    {
      variableKey: 'contact.first_name',
      label: 'Contact first name',
      previewValue: 'Sandeep',
      isActive: true,
      category: 'contact',
      sortOrder: 10,
    },
  ]);
});
describe('semantic template lifecycle routes', () => {
  it('submits only positional content and catalog samples, saving canonical metadata', async () => {
    const response = await POST(request(semantic));
    expect(response.status).toBe(200);
    expect(mocks.submit.mock.calls[0][0].payload.components).toEqual([
      {
        type: 'BODY',
        text: 'Hi {{1}}.',
        example: { body_text: [['Sandeep']] },
      },
    ]);
    expect(state.writes[0]).toMatchObject({
      body_text: 'Hi {{1}}.',
      semantic_content: { body_text: 'Hi {{contact.first_name}}.' },
      semantic_variable_mapping: [
        {
          component: 'BODY',
          position: 1,
          variable_key: 'contact.first_name',
          sample: 'Sandeep',
        },
      ],
      variable_configuration_status: 'configured',
      meta_template_id: 'meta-id',
    });
  });
  it('authors directly from semantic content without transport body fields', async () => {
    const authoring = {
      name: semantic.name,
      category: semantic.category,
      language: semantic.language,
      semantic_content: semantic.semantic_content,
    };
    const response = await POST(request(authoring));
    expect(response.status).toBe(200);
    expect(state.writes[0]).toMatchObject({
      body_text: 'Hi {{1}}.',
      template_origin: 'rgcrm',
    });
  });
  it('refuses create-path replacement of submitted templates', async () => {
    state.existing = { id: 'existing', meta_template_id: 'meta' };
    const response = await POST(request(semantic));
    expect(response.status).toBe(409);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
  it('stores imported mapping without editing Meta or approval status', async () => {
    state.existing = {
      template_origin: 'meta',
      variable_configuration_status: 'needs_mapping',
      id: 'existing',
      meta_template_id: 'meta',
      status: 'APPROVED',
      body_text: 'Hi {{1}}.',
      updated_at: 'stamp',
      sample_values: { body: ['Approved sample'] },
    };
    const response = await mapVariables(
      request({
        mapping: [
          {
            component: 'BODY',
            position: 1,
            variable_key: 'contact.first_name',
          },
        ],
      }),
      { params: Promise.resolve({ id: 'existing' }) }
    );
    expect(response.status).toBe(200);
    expect(mocks.role).toHaveBeenCalledWith('admin');
    expect(state.writes[0]).toMatchObject({
      variable_configuration_status: 'configured',
      semantic_content: { body_text: 'Hi {{contact.first_name}}.' },
    });
    expect(state.writes[0]).not.toHaveProperty('status');
    expect(state.writes[0]).not.toHaveProperty('body_text');
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it('rejects invalid semantic tokens before Meta or persistence', async () => {
    const response = await POST(
      request({
        ...semantic,
        semantic_content: { body_text: 'Hi {{unknown.name}}' },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
  it('rejects positional authoring without semantic content', async () => {
    const response = await POST(
      request({
        name: 'legacy',
        category: 'Utility',
        language: 'en_US',
        body_text: 'Hello {{1}}',
        sample_values: { body: ['Guest'] },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('rejects independent manual mapping of an RGCRM template', async () => {
    state.existing = {
      template_origin: 'rgcrm',
      variable_configuration_status: 'configured',
      body_text: 'Hi {{1}}.',
      semantic_content: { body_text: 'Hi {{contact.first_name}}.' },
    };
    const response = await mapVariables(
      request({
        mapping: [
          { component: 'BODY', position: 1, variable_key: 'property.name' },
        ],
      }),
      { params: Promise.resolve({ id: 'existing' }) }
    );
    expect(response.status).toBe(409);
    expect(state.writes).toEqual([]);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('generates mapping from semantic content even if the caller supplies a different mapping', async () => {
    const response = await POST(
      request({
        ...semantic,
        semantic_variable_mapping: [
          { component: 'BODY', position: 1, variable_key: 'property.name' },
        ],
      })
    );
    expect(response.status).toBe(200);
    expect(state.writes[0]).toMatchObject({
      template_origin: 'rgcrm',
      semantic_variable_mapping: [{ variable_key: 'contact.first_name' }],
    });
  });
  it('requires semantic content on edits before any Meta side effect', async () => {
    state.existing = {
      id: 'saved',
      status: 'APPROVED',
      meta_template_id: 'meta',
    };
    const response = await PATCH(
      request({ ...semantic, semantic_content: undefined }),
      {
        params: Promise.resolve({ id: '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f' }),
      }
    );
    expect(response.status).toBe(400);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
  it('compiles explicit approved-template edits and preserves Meta lifecycle', async () => {
    state.existing = {
      id: 'saved',
      name: 'welcome',
      status: 'APPROVED',
      meta_template_id: 'meta',
      whatsapp_config_id: 'connection',
    };
    const response = await PATCH(request(semantic), {
      params: Promise.resolve({ id: '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.edit.mock.calls[0][0].components[0].text).toBe('Hi {{1}}.');
    expect(state.writes[0]).toMatchObject({
      status: 'PENDING',
      variable_configuration_status: 'configured',
    });
  });
});

it('rejects a terminal BODY variable with an actionable message before contacting Meta', async () => {
  const response = await POST(
    request({
      ...semantic,
      semantic_content: { body_text: 'Hi {{contact.first_name}}' },
    })
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain(
    'cannot start or end with a variable'
  );
  expect(mocks.submit).not.toHaveBeenCalled();
});
it('submits the four-variable booking example in occurrence order without semantic labels or keys', async () => {
  mocks.catalog.mockResolvedValue([
    {
      variableKey: 'contact.first_name',
      label: 'Contact first name',
      previewValue: 'Sandeep',
      isActive: true,
    },
    {
      variableKey: 'listing.name',
      label: 'Listing name',
      previewValue: 'Luxury 1BHK near Cyber Hub',
      isActive: true,
    },
    {
      variableKey: 'reservation.check_in_date',
      label: 'Check-in date',
      previewValue: '2026-10-15',
      isActive: true,
    },
    {
      variableKey: 'reservation.check_out_date',
      label: 'Check-out date',
      previewValue: '2026-10-18',
      isActive: true,
    },
  ]);
  const body =
    'Hi {{contact.first_name}},\nYour booking is confirmed {{listing.name}}\nCheckin: {{reservation.check_in_date}}\nCheckout: {{reservation.check_out_date}}.';
  const response = await POST(
    request({ ...semantic, semantic_content: { body_text: body } })
  );
  expect(response.status).toBe(200);
  const args = mocks.submit.mock.calls[0][0];
  expect(args.wabaId).toBe('waba');
  expect(args.payload).toEqual({
    name: 'welcome',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}},\nYour booking is confirmed {{2}}\nCheckin: {{3}}\nCheckout: {{4}}.',
        example: {
          body_text: [
            [
              'Sandeep',
              'Luxury 1BHK near Cyber Hub',
              '2026-10-15',
              '2026-10-18',
            ],
          ],
        },
      },
    ],
  });
  for (const variable of await mocks.catalog()) {
    expect(JSON.stringify(args.payload)).not.toContain(variable.variableKey);
    expect(JSON.stringify(args.payload)).not.toContain(variable.label);
  }
});
it('returns useful Meta details and retains diagnostics without the access token', async () => {
  const { MetaApiError } = await import('@/lib/whatsapp/meta-api');
  mocks.submit.mockRejectedValue(
    new MetaApiError('Invalid parameter', {
      httpStatus: 400,
      code: 100,
      subcode: 2388299,
      type: 'OAuthException',
      userTitle: 'Invalid body',
      userMessage: 'Remove the terminal parameter. token',
      fbtraceId: 'trace',
    })
  );
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await POST(request(semantic));
  expect(response.status).toBe(502);
  const data = await response.json();
  expect(data.error).toContain('Remove the terminal parameter');
  expect(data.meta_error).toMatchObject({
    code: 100,
    error_subcode: 2388299,
    fbtrace_id: 'trace',
    error_user_title: 'Invalid body',
  });
  expect(JSON.stringify(data)).not.toContain(' token');
  expect(state.writes[0].submission_error).toContain('2388299');
  expect(JSON.stringify(log.mock.calls)).not.toContain('Remove the terminal');
  log.mockRestore();
});

it('creates a contact/workspace semantic template and submits positional Meta content with no PMS', async () => {
  mocks.catalog.mockResolvedValue([
    {
      variableKey: 'contact.first_name',
      label: 'Contact first name',
      previewValue: 'Taylor',
      isActive: true,
      category: 'contact',
      sortOrder: 1,
    },
    {
      variableKey: 'workspace.name',
      label: 'Workspace name',
      previewValue: 'Our team',
      isActive: true,
      category: 'workspace',
      sortOrder: 2,
    },
  ]);
  const response = await POST(
    request({
      ...semantic,
      semantic_content: {
        body_text:
          'Hi {{contact.first_name}}, welcome to {{workspace.name}}. We are happy to help you.',
      },
    })
  );
  expect(response.status).toBe(200);
  expect(mocks.submit.mock.calls[0][0].payload.components[0]).toEqual({
    type: 'BODY',
    text: 'Hi {{1}}, welcome to {{2}}. We are happy to help you.',
    example: { body_text: [['Taylor', 'Our team']] },
  });
  expect(state.writes[0].semantic_variable_mapping).toEqual([
    {
      component: 'BODY',
      position: 1,
      variable_key: 'contact.first_name',
      sample: 'Taylor',
    },
    {
      component: 'BODY',
      position: 2,
      variable_key: 'workspace.name',
      sample: 'Our team',
    },
  ]);
});
