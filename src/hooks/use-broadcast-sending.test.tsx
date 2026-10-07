// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessageTemplate } from '@/types';
import { useBroadcastSending } from './use-broadcast-sending';
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'account' }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => db }));
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let reads: string[];
const db = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'user' } } } }),
  },
  from: (table: string) => {
    reads.push(table);
    const filters: Array<(row: Row) => boolean> = [];
    let patch: Row | undefined;
    const response = () => {
      const rows = (tables[table] ?? []).filter((v) =>
        filters.every((f) => f(v))
      );
      if (patch) {
        rows.forEach((v) => Object.assign(v, patch));
        patch = undefined;
      }
      return { data: rows, error: null };
    };
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => {
        filters.push((v) => v[key] === value);
        return q;
      },
      insert: (input: Row | Row[]) => {
        tables[table] = (Array.isArray(input) ? input : [input]).map(
          (row, i) => ({
            ...row,
            id: table === 'broadcasts' ? 'broadcast' : `recipient-${i}`,
            ...(table === 'broadcast_recipients'
              ? {
                  contact: tables.contacts.find((v) => v.id === row.contact_id),
                }
              : {}),
          })
        );
        return q;
      },
      update: (row: Row) => {
        patch = row;
        return q;
      },
      single: async () => ({ ...response(), data: response().data[0] }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(response()).then(resolve),
    };
    return q;
  },
};
let root: Root,
  host: HTMLDivElement,
  hook: ReturnType<typeof useBroadcastSending>;
function Harness() {
  const api = useBroadcastSending();
  useEffect(() => {
    hook = api;
  }, [api]);
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', h.fetch);
  reads = [];
  tables = {
    contacts: [
      {
        id: 'a',
        account_id: 'account',
        name: 'Sandeep',
        phone: '+14155550123',
      },
      { id: 'b', account_id: 'account', name: '', phone: '+14155550124' },
      { id: 'c', account_id: 'account', name: 'Rahul', phone: '+14155550125' },
    ],
  };
  h.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/resolve-variables'))
      return Response.json({ success: true });
    const body = JSON.parse(init.body as string);
    return Response.json({
      results: body.recipients.map((r: Row) => ({
        phone: r.phone,
        status: r.contact_id === 'b' ? 'failed' : 'sent',
        whatsapp_message_id: 'wamid',
        error:
          r.contact_id === 'b'
            ? 'Required contact information is unavailable.'
            : undefined,
      })),
    });
  });
  host = document.createElement('div');
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it('persists semantic identity and sends recipient contacts rather than pre-resolved positional values', async () => {
  const template = {
    id: 'template',
    name: 'news',
    language: 'en_US',
    variable_configuration_status: 'configured',
  } as MessageTemplate;
  await act(async () => {
    expect(
      await hook.createAndSendBroadcast({
        name: 'News',
        template,
        audience: { type: 'all' },
        variables: [],
        whatsappConfigId: 'config',
      })
    ).toBe('broadcast');
  });
  const validation = JSON.parse(h.fetch.mock.calls[0][1].body);
  expect(validation).toMatchObject({
    template_id: 'template',
    validate_only: true,
  });
  const send = JSON.parse(h.fetch.mock.calls[1][1].body);
  expect(send).toMatchObject({
    template_id: 'template',
    whatsapp_config_id: 'config',
    recipients: [
      { contact_id: 'a', phone: '+14155550123' },
      { contact_id: 'b', phone: '+14155550124' },
      { contact_id: 'c', phone: '+14155550125' },
    ],
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(tables.broadcasts[0]).toMatchObject({
    template_variables: { template_id: 'template' },
    status: 'sent',
  });
  expect(tables.broadcast_recipients.map((v) => v.status)).toEqual([
    'sent',
    'failed',
    'sent',
  ]);
  expect(tables.broadcast_recipients.map((v) => v.template_params)).toEqual([
    [],
    [],
    [],
  ]);
  expect(tables.broadcast_recipients[0].whatsapp_message_id).toBe('wamid');
  expect(reads).not.toContain('contact_custom_values');
  expect(reads.some((v) => v.startsWith('pms_'))).toBe(false);
});
