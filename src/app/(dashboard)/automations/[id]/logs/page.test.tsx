// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../../messages/en.json';
const h = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'account' }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toast, error: h.toast } }));
vi.mock('lucide-react', () => ({
  ArrowLeft: () => null,
  Check: () => null,
  Clock: () => null,
  Minus: () => null,
  Loader2: () => null,
  X: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
}));
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));
vi.mock('next-intl', () => {
  const cache = new Map();
  function lookup(path: string): unknown {
    return path
      .split('.')
      .reduce(
        (obj: unknown, key) => (obj as Record<string, unknown>)?.[key],
        messages
      );
  }
  return {
    useTranslations: (namespace: string) => {
      if (!cache.has(namespace)) {
        const t = Object.assign(
          (key: string, values?: Record<string, unknown>) => {
            let text = String(lookup(`${namespace}.${key}`) ?? key);
            for (const [name, value] of Object.entries(values ?? {}))
              text = text.replace(`{${name}}`, String(value));
            return text;
          },
          {
            has: (key: string) =>
              typeof lookup(`${namespace}.${key}`) === 'string',
          }
        );
        cache.set(namespace, t);
      }
      return cache.get(namespace);
    },
    useFormatter: () => ({ dateTime: () => 'Oct 7, 2026, 10:30 AM' }),
  };
});
import Page from './page';
let host: HTMLDivElement;
let root: Root;
const params = Promise.resolve({ id: 'automation' });
const base = {
  id: 'failed-log',
  trigger_job_id: 'job',
  status: 'failed',
  trigger_event: 'reservation_confirmed',
  trigger_job_attempt_count: 1,
  trigger_job_execution_state: 'failed',
  contact: { name: 'Taylor', phone: '+123' },
  reservation_reference: 'BOOK-102',
  created_at: '2026-10-07T05:00:00Z',
  failure_reason: 'templateSend',
  manual_retry_state: 'eligible',
  job_status: 'failed',
  job_attempt_count: 1,
  steps_executed: [
    {
      step_type: 'send_template',
      status: 'failed',
      failure_reason: 'templateSend',
    },
  ],
};
let logs: Record<string, unknown>[];
const load = async () => {
  await params;
  await act(async () => {
    root.render(<Page params={params} />);
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  logs = [{ ...base }];
  h.fetch.mockImplementation(async () =>
    Response.json({
      automation: {
        id: 'automation',
        name: 'Booking welcome',
        trigger_type: 'reservation_confirmed',
      },
      logs,
    })
  );
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('shows host context and distinct failed/completed attempts without technical internals', async () => {
  logs = [
    {
      ...base,
      id: 'completed-log',
      status: 'success',
      trigger_job_attempt_count: 2,
      trigger_job_execution_state: 'completed',
      manual_retry_state: 'already_completed',
      job_status: 'completed',
      job_attempt_count: 2,
      steps_executed: [
        {
          step_type: 'send_template',
          status: 'success',
          detail: 'PRIVATE META PAYLOAD',
        },
      ],
    },
    {
      ...base,
      manual_retry_state: 'already_completed',
      job_status: 'completed',
      job_attempt_count: 2,
      error_message: 'SECRET ACCESS TOKEN',
    },
  ];
  await load();
  expect(host.textContent).toContain('Attempt 1');
  expect(host.textContent).toContain('Attempt 2');
  expect(host.textContent).toContain('Completed');
  expect(host.textContent).toContain('Failed');
  expect(host.textContent).toContain('Booking welcome');
  expect(host.textContent).toContain('Reservation Confirmed');
  expect(host.textContent).toContain('Taylor');
  expect(host.textContent).toContain('BOOK-102');
  expect(host.querySelector('time')?.dateTime).toBe(base.created_at);
  expect(host.textContent).toContain('Oct 7, 2026, 10:30 AM');
  expect(
    [...host.querySelectorAll('button')].some((b) => b.textContent === 'Retry')
  ).toBe(false);
  await act(async () =>
    (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click()
  );
  expect(host.textContent).toContain('Automation triggered');
  expect(host.textContent).toContain('WhatsApp template sent');
  expect(host.textContent).not.toMatch(
    /PRIVATE|SECRET|send_template|reservation_confirmed|completed-log/
  );
});
it('shows concise failure reason and failed timeline, with a neutral skipped step', async () => {
  logs = [
    {
      ...base,
      steps_executed: [
        { step_type: 'condition', status: 'skipped' },
        ...base.steps_executed,
      ],
    },
  ];
  await load();
  await act(async () =>
    (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click()
  );
  expect(host.textContent).toContain('Step skipped');
  expect(host.textContent).toContain('WhatsApp template failed');
  expect(host.textContent).toContain(
    'Check the template and WhatsApp connection.'
  );
  expect(
    host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')
  ).toBe('true');
});
it('processing state takes precedence over the placeholder failed status', async () => {
  logs = [
    {
      ...base,
      trigger_job_execution_state: 'processing',
      job_status: 'processing',
      manual_retry_state: 'already_retried',
      steps_executed: [],
    },
  ];
  await load();
  expect(host.textContent).toContain('Processing');
  expect(host.querySelector('tbody')?.textContent).not.toContain('Failed');
  expect(host.textContent).not.toContain('could not be sent');
  expect(
    [...host.querySelectorAll('button')].some((b) => b.textContent === 'Retry')
  ).toBe(false);
});
it('queued retry preserves the failed attempt and does not label older attempts queued', async () => {
  logs = [
    { ...base, job_status: 'scheduled', manual_retry_state: 'already_retried' },
    {
      ...base,
      id: 'older',
      trigger_job_attempt_count: 0,
      job_status: 'scheduled',
      manual_retry_state: 'already_retried',
    },
  ];
  await load();
  const rows = host.querySelectorAll('tr[data-execution]');
  expect(rows[0].textContent).toContain('Failed');
  expect(rows[0].textContent).toContain('Queued');
  expect(rows[1].textContent).not.toContain('Queued');
});
it('uses existing Retry endpoint, disables pending action, and refreshes Activity', async () => {
  let resolvePost!: (value: Response) => void;
  const post = new Promise<Response>((resolve) => {
    resolvePost = resolve;
  });
  h.fetch.mockImplementation(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? post
      : Response.json({
          automation: { id: 'automation', name: 'Booking welcome' },
          logs,
        })
  );
  await load();
  const retry = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Retry'
  )!;
  await act(async () => {
    retry.click();
    retry.click();
  });
  expect(retry.disabled).toBe(true);
  expect(retry.textContent).toBe('Retrying…');
  expect(
    h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')
  ).toHaveLength(1);
  expect(h.fetch).toHaveBeenCalledWith(
    '/api/automations/executions/failed-log/retry',
    { method: 'POST' }
  );
  logs = [
    { ...base, job_status: 'scheduled', manual_retry_state: 'already_retried' },
  ];
  await act(async () =>
    resolvePost(Response.json({ status: 'queued' }, { status: 202 }))
  );
  expect(
    h.fetch.mock.calls.filter(
      ([url]) => url === '/api/automations/automation/logs'
    )
  ).toHaveLength(2);
  expect(host.textContent).toContain('Queued');
  expect(host.textContent).toContain('Attempt 1');
  expect(host.textContent).toContain('Failed');
});
it('polls queued retries into a new processing/completed attempt while preserving failed history', async () => {
  vi.useFakeTimers();
  try {
    logs = [
      {
        ...base,
        job_status: 'scheduled',
        manual_retry_state: 'already_retried',
      },
    ];
    await load();
    const old = {
      ...base,
      job_status: 'processing',
      job_attempt_count: 2,
      manual_retry_state: 'already_retried',
    };
    const next = {
      ...base,
      id: 'attempt-two',
      job_status: 'processing',
      job_attempt_count: 2,
      trigger_job_attempt_count: 2,
      trigger_job_execution_state: 'processing',
      manual_retry_state: 'already_retried',
      steps_executed: [],
    };
    logs = [next, old];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(host.textContent).toContain('Processing');
    expect(host.textContent).toContain('Attempt 1');
    expect(host.textContent).toContain('Attempt 2');
    expect(host.textContent).toContain('Failed');
    expect(host.textContent).not.toContain('Queued');
    logs = [
      {
        ...next,
        status: 'success',
        trigger_job_execution_state: 'completed',
        job_status: 'completed',
        manual_retry_state: 'already_completed',
      },
      {
        ...old,
        job_status: 'completed',
        manual_retry_state: 'already_completed',
      },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(host.textContent).toContain('Completed');
    expect(host.textContent).toContain('Failed');
    const calls = h.fetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(h.fetch).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});

it('uses a table with headers and filters executions by status and contact/reference', async () => {
  logs = [
    { ...base },
    {
      ...base,
      id: 'success',
      status: 'success',
      contact: { name: 'Morgan' },
      reservation_reference: 'BOOK-200',
      manual_retry_state: 'already_completed',
    },
  ];
  await load();
  expect(
    [...host.querySelectorAll('th')].map((cell) => cell.textContent)
  ).toEqual([
    'Trigger',
    'Contact',
    'Reservation',
    'Executed at',
    'Status',
    'Attempt',
    'Actions',
  ]);
  expect(host.querySelector('h1')?.textContent).toBe('Booking welcome');
  for (const row of host.querySelectorAll('tr[data-execution]')) {
    expect(row.textContent).not.toContain('Booking welcome');
  }
  expect(host.querySelector('input')?.placeholder).toBe('Contact or reservation…');
  expect(host.querySelectorAll('tr[data-execution]')).toHaveLength(2);
  const status = host.querySelector('select')!;
  await act(async () => {
    status.value = 'completed';
    status.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelectorAll('tr[data-execution]')).toHaveLength(1);
  expect(host.querySelector('tbody')?.textContent).toContain('Morgan');
  const search = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!.call(search, 'BOOK-102');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelectorAll('tr[data-execution]')).toHaveLength(0);
  expect(host.querySelector('tbody')?.textContent).toContain(
    'No matching executions'
  );
});
it('explains blocked WhatsApp retries without exposing provider IDs', async () => {
  logs = [
    {
      ...base,
      manual_retry_state: 'unsafe_to_retry',
      retry_block_reason: 'whatsapp_accepted',
    },
  ];
  await load();
  expect(host.textContent).toContain(
    'WhatsApp may already have accepted this message'
  );
  expect(
    [...host.querySelectorAll('button')].some(
      (button) => button.textContent === 'Retry'
    )
  ).toBe(false);
});
