// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReservationsPage } from './reservations-page';

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
  rpc: vi.fn(),
}));
const client = { rpc: h.rpc };
vi.mock('next/navigation', () => ({
  useSearchParams: () => h.params,
  useRouter: () => ({ replace: h.replace }),
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'workspace' }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => client }));
const properties = {
  loading: false,
  options: [],
  integrations: [{ status: 'connected' }],
};
vi.mock('@/hooks/use-workspace-properties', () => ({
  useWorkspaceProperties: () => properties,
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  h.params = new URLSearchParams('view=staying_now');
  h.replace.mockReset();
  h.rpc.mockReset();
  h.rpc.mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_crm_reservation_filter_options')
        return {
          data: { channels: ['Walk-In'], statuses: ['confirmed'] },
          error: null,
        };
      return {
        data: ['staying_now', 'all'].includes(String(args.p_lifecycle))
          ? Array.from({ length: 3 }, (_, index) => ({
              id: `reservation-${index}`,
              property_id: 'property',
              status: 'confirmed',
              lifecycle: 'staying_now',
              guest_name: `Guest ${index + 1}`,
              total_count: 3,
            }))
          : [],
        error: null,
      };
    }
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('keeps the three current stays visible when switching to All', async () => {
  await act(async () => root.render(<ReservationsPage />));
  expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
  const all = Array.from(
    host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  ).find((tab) => tab.textContent === 'All')!;
  await act(async () => all.click());
  expect(h.replace).toHaveBeenCalledWith('/reservations?view=all');

  h.params = new URLSearchParams('view=all');
  await act(async () => root.render(<ReservationsPage />));
  expect(h.rpc).toHaveBeenLastCalledWith(
    'list_crm_reservations',
    expect.objectContaining({
      p_lifecycle: 'all',
      p_offset: 0,
    })
  );
  expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
  const selected = host.querySelector('[role="tab"][aria-selected="true"]');
  expect(selected?.textContent).toBe('All');
  expect(selected?.querySelector('svg')).not.toBeNull();
});

it('shows filter names and readable selected values', async () => {
  h.params = new URLSearchParams(
    'view=all&channel=Walk-In&status=confirmed&from=2026-10-27&to=2026-10-29'
  );
  await act(async () => root.render(<ReservationsPage />));
  expect(
    host.querySelector('[aria-label="Filter by channel"]')?.textContent
  ).toContain('ChannelWalk-In');
  expect(
    host.querySelector('[aria-label="Filter by status"]')?.textContent
  ).toContain('StatusConfirmed');
  expect(host.textContent).toContain('Oct 27');
  expect(host.textContent).toContain('Oct 29');

  h.params = new URLSearchParams('view=all');
  await act(async () => root.render(<ReservationsPage />));
  expect(
    host.querySelector('[aria-label="Filter by channel"]')?.textContent
  ).toContain('All channels');
  expect(
    host.querySelector('[aria-label="Filter by status"]')?.textContent
  ).toContain('All statuses');
});
