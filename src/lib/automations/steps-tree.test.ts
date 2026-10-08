import { beforeEach, expect, it, vi } from 'vitest';
import { insertSteps, replaceSteps, type BuilderStepInput } from './steps-tree';
const h = vi.hoisted(() => ({ deleted: vi.fn(), inserted: vi.fn() }));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      delete: () => {
        h.deleted();
        return { eq: async () => ({ error: null }) };
      },
      insert: async (rows: unknown) => {
        h.inserted(rows);
        return { error: null };
      },
    }),
  }),
}));
const templateId = '11111111-1111-1111-1111-111111111111';
beforeEach(() => vi.clearAllMocks());
it.each([insertSteps, replaceSteps])(
  'rejects invalid actions before database mutation in %s',
  async (write) => {
    for (const step_config of [
      { template_name: 'old' },
      { template_id: templateId, variables: {} },
      { template_id: templateId, variable_mappings: [] },
    ]) {
      for (const nested of [false, true]) {
        const action = { step_type: 'send_template', step_config };
        const steps = nested
          ? [
              {
                step_type: 'condition',
                step_config: {},
                branches: { yes: [action], no: [] },
              },
            ]
          : [action];
        expect(await write('automation', steps)).toBeTruthy();
        expect(h.deleted).not.toHaveBeenCalled();
        expect(h.inserted).not.toHaveBeenCalled();
      }
    }
  }
);
it.each([false, true])(
  'retains semantic nested and flat seed persistence, flat=%s',
  async (flat) => {
    const action: BuilderStepInput = {
      step_type: 'send_template',
      step_config: { template_id: templateId },
    };
    const steps = flat
      ? [
          { step_type: 'condition', step_config: {} },
          { ...action, parent_index: 0, branch: 'yes' as const },
        ]
      : [
          {
            step_type: 'condition',
            step_config: {},
            branches: { yes: [action], no: [] },
          },
        ];
    expect(await replaceSteps('automation', steps)).toBeNull();
    const rows = h.inserted.mock.calls[0][0];
    expect(h.deleted).toHaveBeenCalledOnce();
    expect(rows[1]).toMatchObject({
      parent_step_id: rows[0].id,
      branch: 'yes',
      step_config: { template_id: templateId },
    });
  }
);
it('allows empty drafts and clearing steps', async () => {
  expect(await insertSteps('automation', [])).toBeNull();
  expect(h.inserted).not.toHaveBeenCalled();
  expect(await replaceSteps('automation', [])).toBeNull();
  expect(h.deleted).toHaveBeenCalledOnce();
});
