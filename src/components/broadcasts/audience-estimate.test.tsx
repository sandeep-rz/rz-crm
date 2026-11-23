// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Step2SelectAudience } from './step2-select-audience';
const h = vi.hoisted(() => ({
  accountId: 'A',
  count: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: h.accountId }),
}));
vi.mock('next-intl', async (original) => ({
  ...(await original<typeof import('next-intl')>()),
  useTranslations: () => h.translate,
}));
vi.mock('@/lib/broadcast-audience', () => ({ countAudience: h.count }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        order: async () => ({ data: [], error: null }),
      };
      return query;
    },
  }),
}));
let host: HTMLDivElement, root: Root;
const audience = { type: 'all' as const };
async function render(value = audience) {
  await act(async () =>
    root.render(
      <Step2SelectAudience
        audience={value}
        onUpdate={() => {}}
        onNext={() => {}}
        onBack={() => {}}
      />
    )
  );
}
beforeEach(() => {
  h.accountId = 'A';
  h.count.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it('ignores an older estimate that completes after the newer audience estimate', async () => {
  let finish!: (n: number) => void;
  h.count
    .mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finish = resolve;
      })
    )
    .mockResolvedValueOnce(42);
  await render();
  await render({ ...audience, excludeTagIds: ['excluded'] } as typeof audience);
  expect(host.textContent).toContain('42');
  await act(async () => finish(999));
  expect(host.textContent).toContain('42');
  expect(host.textContent).not.toContain('999');
});
it('retains account scoping and ignores old workspace results', async () => {
  let finish!: (n: number) => void;
  h.count
    .mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finish = resolve;
      })
    )
    .mockResolvedValueOnce(7);
  await render();
  h.accountId = 'B';
  await render();
  await act(async () => finish(999));
  expect(host.textContent).not.toContain('999');
  expect(host.textContent).toContain('7');
  expect(h.count.mock.calls.map((call) => call[2])).toEqual(['A', 'B']);
});
it('does not let a rejected old request replace a successful current estimate', async () => {
  let reject!: (reason: Error) => void;
  h.count
    .mockReturnValueOnce(
      new Promise<number>((_resolve, no) => {
        reject = no;
      })
    )
    .mockResolvedValueOnce(18);
  await render();
  await render({ ...audience, excludeTagIds: ['excluded'] } as typeof audience);
  await act(async () => reject(new Error('old failure')));
  expect(host.textContent).toContain('18');
  expect(host.textContent).not.toContain('Select an audience type');
});
