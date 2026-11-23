// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlowEditorProvider, useFlowEditor } from './flow-editor-state';
import type { FlowRow, FlowNodeRow } from '@/lib/flows/types';
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-intl', async (original) => ({
  ...(await original<typeof import('next-intl')>()),
  useTranslations: () => h.translate,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
let editor: ReturnType<typeof useFlowEditor>, root: Root;
const flow = {
  id: 'flow',
  account_id: 'account',
  user_id: 'user',
  name: 'Welcome',
  description: null,
  status: 'draft',
  trigger_type: 'manual',
  trigger_config: {},
  entry_node_id: 'start',
  whatsapp_config_id: 'connection',
  fallback_policy: {},
  execution_count: 0,
  last_executed_at: null,
  created_at: 'now',
  updated_at: 'now',
} as FlowRow;
const nodes = [
  {
    id: 'start',
    flow_id: 'flow',
    node_key: 'start',
    node_type: 'start',
    config: { next_node_key: 'end' },
  },
  { id: 'end', flow_id: 'flow', node_key: 'end', node_type: 'end', config: {} },
] as FlowNodeRow[];
function Capture() {
  const state = useFlowEditor();
  useEffect(() => {
    editor = state;
  }, [state]);
  return null;
}
beforeEach(async () => {
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(
      <FlowEditorProvider initialFlow={flow} initialNodes={nodes}>
        <Capture />
      </FlowEditorProvider>
    );
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it('does not activate stored content when saving the current graph fails', async () => {
  h.fetch.mockResolvedValue(
    Response.json({ error: 'Save failed' }, { status: 500 })
  );
  expect(editor.canActivate).toBe(true);
  await act(async () => {
    await editor.setStatus('active');
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.fetch.mock.calls[0][1].method).toBe('PUT');
  expect(editor.state.status).toBe('draft');
  expect(editor.activating).toBe(false);
});
it('saves the current RZ connection and graph before activation succeeds', async () => {
  h.fetch.mockImplementation(async () => Response.json({ ok: true }));
  await act(async () => {
    await editor.setStatus('active');
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toMatchObject({
    whatsapp_config_id: 'connection',
    entry_node_id: 'start',
  });
  expect(h.fetch.mock.calls[1][0]).toBe('/api/flows/flow/activate');
  expect(editor.state.status).toBe('active');
});
