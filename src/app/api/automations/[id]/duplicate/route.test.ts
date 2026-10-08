import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from './route';

const h = vi.hoisted(() => ({
  compatibility: vi.fn(async () => [] as { path: string; message: string }[]),
  steps: [] as Record<string, unknown>[],
  writes: [] as { table: string; value: unknown }[],
  error: null as { message: string } | null,
}));
vi.mock('@/lib/automations/validate-template-compatibility', () => ({
  validateAutomationTemplateCompatibility: h.compatibility,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'account', userId: 'author' }),
  toErrorResponse: vi.fn(),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      let inserting = false;
      const q = {
        select: () => q,
        eq: () => q,
        insert: (value: unknown) => {
          inserting = true;
          h.writes.push({ table, value });
          return q;
        },
        maybeSingle: async () => ({
          data: {
            id: 'original',
            account_id: 'account',
            name: 'Original',
            trigger_type: 'tag_added',
          },
          error: null,
        }),
        single: async () => ({ data: { id: 'copy' }, error: null }),
        order: async () => ({ data: h.steps, error: h.error }),
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve({
            data: null,
            error: inserting ? null : h.error,
          }).then(resolve),
      };
      return q;
    },
  }),
}));
const templateId = '11111111-1111-1111-1111-111111111111';
const request = new Request(
  'http://localhost/api/automations/original/duplicate',
  { method: 'POST' }
);
const params = { params: Promise.resolve({ id: 'original' }) };
beforeEach(() => {
  h.compatibility.mockReset().mockResolvedValue([]);
  h.steps = [];
  h.writes = [];
  h.error = null;
});
it.each([
  { template_name: 'old' },
  { template_id: templateId, variables: {} },
  { template_id: templateId, variable_mappings: [] },
])(
  'refuses invalid nested flat action before creating a copy: %j',
  async (step_config) => {
    h.steps = [
      { id: 'parent', step_type: 'condition', step_config: {}, position: 0 },
      {
        id: 'child',
        parent_step_id: 'parent',
        branch: 'no',
        step_type: 'send_template',
        step_config,
        position: 0,
      },
    ];
    expect((await POST(request, params)).status).toBe(400);
    expect(h.writes).toEqual([]);
  }
);
it('clones semantic actions and remaps nested parents', async () => {
  h.steps = [
    { id: 'parent', step_type: 'condition', step_config: {}, position: 0 },
    {
      id: 'child',
      parent_step_id: 'parent',
      branch: 'yes',
      step_type: 'send_template',
      step_config: { template_id: templateId },
      position: 0,
    },
  ];
  expect((await POST(request, params)).status).toBe(201);
  const rows = h.writes[1].value as Record<string, unknown>[];
  expect(rows[1]).toMatchObject({
    automation_id: 'copy',
    parent_step_id: rows[0].id,
    branch: 'yes',
    step_config: { template_id: templateId },
  });
});
it('does not create an empty copy when reading source steps fails', async () => {
  h.error = { message: 'read failed' };
  expect((await POST(request, params)).status).toBe(500);
  expect(h.writes).toEqual([]);
});

it('duplicate validates the stored trigger and reconstructed nested tree before creating a copy', async () => {
  h.steps = [
    {
      id: 'parent',
      parent_step_id: null,
      branch: null,
      step_type: 'condition',
      step_config: {},
      position: 0,
    },
    {
      id: 'child',
      parent_step_id: 'parent',
      branch: 'no',
      step_type: 'send_template',
      step_config: { template_id: templateId },
      position: 0,
    },
  ];
  const issues = [
    {
      path: 'steps[0].no.steps[0].template_id',
      message:
        'This template requires reservation context and cannot be used with this automation trigger.',
    },
  ];
  h.compatibility.mockResolvedValueOnce(issues);
  const response = await POST(request, params);
  expect(response.status).toBe(400);
  expect((await response.json()).issues).toEqual(issues);
  expect(h.compatibility).toHaveBeenCalledWith(
    expect.anything(),
    'account',
    'tag_added',
    [
      expect.objectContaining({
        id: 'parent',
        branches: {
          yes: [],
          no: [
            expect.objectContaining({
              id: 'child',
              step_type: 'send_template',
            }),
          ],
        },
      }),
    ]
  );
  expect(h.writes).toEqual([]);
});
