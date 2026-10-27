// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResponseTimeChart } from './response-time-chart';
import type { ResponseTimeSummary } from '@/lib/dashboard/types';
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/tremor/bar-chart', () => ({
  BarChart: ({ data }: { data: unknown }) => (
    <div data-testid="chart">{JSON.stringify(data)}</div>
  ),
}));
let host: HTMLDivElement, root: Root;
const series = (minutes: number) => ({
  buckets: Array.from({ length: 7 }, (_, dow) => ({
    dow,
    avgMinutes: dow === 0 ? minutes : null,
    samples: dow === 0 ? 1 : 0,
  })),
  thisWeekAvg: minutes,
  lastWeekAvg: null,
});
const data: ResponseTimeSummary = {
  timeZone: 'Asia/Kolkata',
  human: series(15),
  ai: series(2),
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('switches between human and AI samples with clear selected state', async () => {
  await act(async () =>
    root.render(<ResponseTimeChart data={data} loading={false} />)
  );
  expect(host.querySelector('[data-testid="chart"]')?.textContent).toContain(
    '15'
  );
  expect(host.textContent).toContain('Asia/Kolkata');
  const ai = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === 'aiReplies'
  )!;
  await act(async () => ai.click());
  expect(ai.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('[data-testid="chart"]')?.textContent).toContain(
    '2'
  );
  expect(
    host.querySelector('[data-testid="chart"]')?.textContent
  ).not.toContain('15');
});
it('shows a failed load distinctly from no replies, with retry', async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(
      <ResponseTimeChart data={null} loading={false} error onRetry={retry} />
    )
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'loadFailed'
  );
  expect(host.textContent).not.toContain('noReplies');
  await act(async () =>
    Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'retry')!
      .click()
  );
  expect(retry).toHaveBeenCalledOnce();
});

it('keeps a real zero-minute response distinct from days without samples', async () => {
  await act(async () =>
    root.render(
      <ResponseTimeChart data={{ ...data, human: series(0) }} loading={false} />
    )
  );
  const rows = JSON.parse(
    host.querySelector('[data-testid="chart"]')!.textContent!
  );
  expect(rows[0]['Avg minutes']).toBe(0);
  expect(rows[1]['Avg minutes']).toBeNull();
});
