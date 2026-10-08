import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from './route';

const h = vi.hoisted(() => ({
  written: [] as Record<string, unknown>[],
  existing: null as Record<string, unknown> | null,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'account',
    userId: 'user',
    supabase: db,
  }),
  ForbiddenError: class extends Error {},
  UnauthorizedError: class extends Error {},
  toErrorResponse: () =>
    Response.json({ error: 'Unexpected failure' }, { status: 500 }),
}));
vi.mock('@/lib/whatsapp/connection-resolver', () => ({
  resolveWhatsAppConnection: async () => ({
    id: 'connection',
    wabaId: 'waba',
    accessToken: 'token',
  }),
}));
const db = {
  from: () => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: h.existing, error: null }),
      insert: (row: Record<string, unknown>) => {
        h.written.push(row);
        return query;
      },
      update: (row: Record<string, unknown>) => {
        h.written.push(row);
        return query;
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    };
    return query;
  },
};
beforeEach(() => {
  h.written = [];
  h.existing = null;
});
afterEach(() => vi.unstubAllGlobals());
const staticBody = { type: 'BODY', text: 'Thank you for contacting our team.' };
async function sync(components: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        data: [
          {
            id: 'meta',
            name: 'welcome',
            language: 'en_US',
            status: 'APPROVED',
            category: 'UTILITY',
            components,
          },
        ],
      })
    )
  );
  return POST(
    new Request('http://localhost/api/whatsapp/templates/sync', {
      method: 'POST',
      body: '{}',
    })
  );
}

it.each([
  [[staticBody], 'configured'],
  [
    [staticBody, { type: 'HEADER', format: 'TEXT', text: 'Welcome' }],
    'configured',
  ],
  [
    [
      staticBody,
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Thanks' },
          { type: 'URL', text: 'Visit', url: 'https://example.test/help' },
        ],
      },
    ],
    'configured',
  ],
  [
    [{ type: 'BODY', text: 'Hello {{1}}, thank you for contacting our team.' }],
    'needs_mapping',
  ],
  [
    [staticBody, { type: 'HEADER', format: 'TEXT', text: 'Hello {{1}}' }],
    'needs_mapping',
  ],
  [
    [
      staticBody,
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Visit', url: 'https://example.test/{{1}}' },
        ],
      },
    ],
    'needs_mapping',
  ],
] as const)(
  'syncs component requirements consistently: %j → %s',
  async (components, status) => {
    expect((await sync([...components])).status).toBe(200);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]).toMatchObject({
      template_origin: 'meta',
      variable_configuration_status: status,
      semantic_variable_mapping: [],
    });
    if (status === 'configured')
      expect(h.written[0].semantic_content).toMatchObject({
        body_text: staticBody.text,
      });
    else expect(h.written[0].semantic_content).toBeNull();
  }
);

it('repairs an unchanged static import with stale needs_mapping metadata during normal sync', async () => {
  h.existing = {
    id: 'local',
    template_origin: 'meta',
    body_text: staticBody.text,
    header_type: null,
    header_content: null,
    buttons: null,
    semantic_content: null,
    semantic_variable_mapping: [],
    variable_configuration_status: 'needs_mapping',
  };
  const response = await sync([staticBody]);
  expect(await response.json()).toMatchObject({
    updated: 1,
    inserted: 0,
    errors: [],
  });
  expect(h.written[0]).toMatchObject({
    variable_configuration_status: 'configured',
    semantic_content: { body_text: staticBody.text },
    semantic_variable_mapping: [],
  });
});
