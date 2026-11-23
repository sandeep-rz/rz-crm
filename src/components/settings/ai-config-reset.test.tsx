// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AiConfig } from './ai-config';
const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    accountId: 'A',
    accountRole: 'admin',
    profileLoading: false,
  }),
}));
vi.mock('next-intl', async (original) => ({
  ...(await original<typeof import('next-intl')>()),
  useTranslations: () => h.translate,
}));
vi.mock('@/lib/account/members', () => ({
  fetchAccountMembers: async () => [],
  memberLabel: () => '',
}));
vi.mock('./ai-knowledge', () => ({
  AiKnowledgeCard: ({ hasEmbeddingsKey }: { hasEmbeddingsKey: boolean }) => (
    <div data-testid="knowledge-key">{String(hasEmbeddingsKey)}</div>
  ),
}));
let root: Root, host: HTMLDivElement;
function input(id: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`#${id}`)!;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
function button(key: string) {
  return Array.from(host.querySelectorAll('button')).find(
    (item) => item.textContent === key
  )!;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', h.fetch);
  h.fetch
    .mockReset()
    .mockImplementation(async (_url: string, init?: RequestInit) =>
      Response.json(
        init?.method
          ? { ok: true }
          : {
              configured: true,
              provider: 'openai',
              model: 'gpt-4.1-mini',
              has_key: true,
              has_embeddings_key: true,
              is_active: true,
              auto_reply_enabled: false,
            }
      )
    );
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it('clears stored and edited embeddings-key state after removing AI configuration', async () => {
  await act(async () => root.render(<AiConfig />));
  expect(
    host.querySelector<HTMLInputElement>('#ai-embeddings-key')!.value
  ).not.toBe('');
  await act(async () => input('ai-embeddings-key', 'edited-test-key'));
  expect(host.querySelector('[data-testid="knowledge-key"]')!.textContent).toBe(
    'true'
  );
  await act(async () => button('remove').click());
  expect(
    host.querySelector<HTMLInputElement>('#ai-embeddings-key')!.value
  ).toBe('');
  expect(host.querySelector('[data-testid="knowledge-key"]')!.textContent).toBe(
    'false'
  );
  await act(async () => input('ai-key', 'new-test-key'));
  await act(async () => button('save').click());
  const save = h.fetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(save).toBeDefined();
  expect(JSON.parse(save![1].body)).not.toHaveProperty('embeddings_api_key');
});
