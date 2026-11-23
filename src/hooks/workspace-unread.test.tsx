// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTotalUnread } from './use-total-unread';
import { useUnreadNotifications } from './use-unread-notifications';
import NotificationsPage from '@/app/(dashboard)/notifications/page';
type Row = Record<string, unknown>;
type Result = { data: Row[] | null; count: number | null; error: null };
type Change = { eventType: string; new: Row; old: Row };
type Handler = {
  table: string;
  event: string;
  filter?: string;
  callback: (payload: Change) => void;
};
type Channel = {
  name: string;
  handlers: Handler[];
  active: boolean;
  status?: (status: string) => void;
};
const h = vi.hoisted(() => ({
  accountId: 'A' as string | null,
  userId: 'user' as string | null,
  push: vi.fn(),
  translate: (key: string) => key,
  toast: vi.fn(),
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    accountId: h.accountId,
    user: h.userId ? { id: h.userId } : null,
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => db }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('next-intl', async (original) => ({
  ...(await original<typeof import('next-intl')>()),
  useTranslations: () => h.translate,
}));
vi.mock('sonner', () => ({ toast: { error: h.toast } }));
let tables: Record<string, Row[]>,
  channels: Channel[],
  reads: { table: string; filters: unknown[][]; mode: string }[],
  writes: { table: string; filters: unknown[][] }[];
let serverCap: number;
let gates: { table: string; mode: string; wait: Promise<void> }[];
function hold(table: string, mode = 'select') {
  let done!: () => void;
  const wait = new Promise<void>((resolve) => {
    done = resolve;
  });
  gates.push({ table, mode, wait });
  return done;
}
const db = {
  from(table: string) {
    const filters: unknown[][] = [];
    let mode = 'select',
      patch: Row = {},
      limit = Infinity,
      head = false;
    const matches = (row: Row) =>
      filters.every(([op, key, value]) =>
        op === 'gt'
          ? String(row[String(key)]) > String(value)
          : row[String(key)] === value
      );
    const execute = async (): Promise<Result> => {
      const rows = (tables[table] ?? [])
        .filter(matches)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (mode === 'update') {
        rows.forEach((row) => Object.assign(row, patch));
        writes.push({ table, filters });
      } else reads.push({ table, filters, mode });
      const result: Result = {
        data: head
          ? null
          : structuredClone(rows.slice(0, Math.min(limit, serverCap))),
        count: head ? rows.length : null,
        error: null,
      };
      const gateIndex = gates.findIndex(
        (g) => g.table === table && g.mode === mode
      );
      if (gateIndex >= 0) await gates.splice(gateIndex, 1)[0].wait;
      return result;
    };
    const q = {
      select: (_columns: string, options?: { head?: boolean }) => {
        head = Boolean(options?.head);
        return q;
      },
      eq: (key: string, value: unknown) => {
        filters.push(['eq', key, value]);
        return q;
      },
      is: (key: string, value: unknown) => {
        filters.push(['eq', key, value]);
        return q;
      },
      gt: (key: string, value: unknown) => {
        filters.push(['gt', key, value]);
        return q;
      },
      order: () => q,
      limit: (n: number) => {
        limit = n;
        return q;
      },
      update: (value: Row) => {
        mode = 'update';
        patch = value;
        return q;
      },
      then: (
        resolve: (result: Result) => unknown,
        reject?: (error: unknown) => unknown
      ) => execute().then(resolve, reject),
    };
    return q;
  },
  channel(name: string) {
    const item: Channel = { name, handlers: [], active: true };
    channels.push(item);
    const channel = {
      on: (
        _kind: string,
        config: Omit<Handler, 'callback'>,
        callback: Handler['callback']
      ) => {
        item.handlers.push({ ...config, callback });
        return channel;
      },
      subscribe: (status?: Channel['status']) => {
        item.status = status;
        return channel;
      },
    };
    return channel;
  },
  removeChannel: vi.fn(async () => {}),
};
function emit(table: string, eventType: string, row: Row) {
  const current = tables[table].find((item) => item.id === row.id);
  if (eventType === 'DELETE')
    tables[table] = tables[table].filter((item) => item.id !== row.id);
  else if (current) Object.assign(current, row);
  else tables[table].push({ ...row });
  const payload: Change = {
    eventType,
    new: eventType === 'DELETE' ? {} : row,
    old: eventType === 'DELETE' ? row : { id: row.id },
  };
  for (const channel of channels)
    for (const handler of channel.handlers) {
      if (
        handler.table !== table ||
        (handler.event !== '*' && handler.event !== eventType)
      )
        continue;
      const account = row.account_id;
      if (
        handler.filter &&
        account &&
        handler.filter !== `account_id=eq.${account}`
      )
        continue;
      handler.callback(payload);
    }
}
let root: Root,
  host: HTMLDivElement,
  total: number,
  badge: number,
  withPage: boolean;
function Capture() {
  const conv = useTotalUnread(),
    notifications = useUnreadNotifications();
  useEffect(() => {
    total = conv;
    badge = notifications;
  }, [conv, notifications]);
  return withPage ? <NotificationsPage /> : null;
}
async function render() {
  await act(async () => {
    root.render(<Capture />);
  });
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
const notification = (id: string, account_id = 'A', user_id = 'user') => ({
  id,
  account_id,
  user_id,
  read_at: null,
  type: 'conversation_assigned',
  title: id,
  body: 'Assigned',
  created_at: '2026-11-23T00:00:00Z',
  conversation_id: `conversation-${id}`,
});
beforeEach(() => {
  h.accountId = 'A';
  h.userId = 'user';
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  tables = { conversations: [], notifications: [] };
  channels = [];
  reads = [];
  writes = [];
  gates = [];
  serverCap = 1000;
  withPage = false;
  total = 0;
  badge = 0;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
describe('workspace unread state', () => {
  it('pages beyond the server cap and counts conversations rather than messages', async () => {
    tables.conversations = Array.from({ length: 1205 }, (_, i) => ({
      id: String(i).padStart(6, '0'),
      account_id: 'A',
      unread_count: 10,
    }));
    tables.conversations.push({
      id: 'foreign',
      account_id: 'B',
      unread_count: 1,
    });
    tables.notifications = [
      notification('mine'),
      notification('other-account', 'B'),
      notification('other-user', 'A', 'teammate'),
    ];
    await render();
    expect(total).toBe(1205);
    expect(badge).toBe(1);
    expect(
      reads.filter((read) => read.table === 'conversations').length
    ).toBeGreaterThan(2);
    expect(
      reads
        .filter((read) => read.table === 'conversations')
        .every((read) =>
          read.filters.some(
            ([op, key, value]) =>
              op === 'eq' && key === 'account_id' && value === 'A'
          )
        )
    ).toBe(true);
  });
  it('overlays reads, deletes and incoming messages during a keyset snapshot', async () => {
    serverCap = 2;
    tables.conversations = [
      { id: '01', account_id: 'A', unread_count: 1 },
      { id: '02', account_id: 'A', unread_count: 1 },
      { id: '03', account_id: 'A', unread_count: 1 },
      { id: '04', account_id: 'A', unread_count: 1 },
    ];
    const release = hold('conversations');
    await render();
    await act(async () => {
      emit('conversations', 'UPDATE', {
        id: '01',
        account_id: 'A',
        unread_count: 0,
      });
      emit('conversations', 'DELETE', { id: '02' });
      emit('conversations', 'INSERT', {
        id: '00',
        account_id: 'A',
        unread_count: 1,
      });
      release();
    });
    expect(total).toBe(3); // 00, 03, 04; removing the first page must not skip later rows.
  });
  it('discards old-account snapshots and realtime callbacks after a workspace switch', async () => {
    tables.conversations = [
      { id: 'a', account_id: 'A', unread_count: 1 },
      { id: 'b', account_id: 'B', unread_count: 1 },
      { id: 'b2', account_id: 'B', unread_count: 1 },
    ];
    tables.notifications = [notification('a'), notification('b', 'B')];
    const releaseConversations = hold('conversations'),
      releaseNotifications = hold('notifications');
    await render();
    const oldCallbacks = channels.flatMap((channel) => channel.handlers);
    h.accountId = 'B';
    await render();
    expect(total).toBe(2);
    expect(badge).toBe(1);
    await act(async () => {
      oldCallbacks.forEach((handler) =>
        handler.callback({
          eventType: 'INSERT',
          new: {
            id: 'old',
            account_id: 'A',
            user_id: 'user',
            unread_count: 10,
          },
          old: {},
        })
      );
      releaseConversations();
      releaseNotifications();
    });
    expect(total).toBe(2);
    expect(badge).toBe(1);
  });
  it('uses authoritative notification counts for repeated and partial updates and id-only deletes', async () => {
    tables.notifications = [
      notification('one'),
      notification('two'),
      notification('foreign', 'B'),
    ];
    await render();
    expect(badge).toBe(2);
    await act(async () =>
      emit('notifications', 'UPDATE', {
        ...notification('one'),
        read_at: 'now',
      })
    );
    expect(badge).toBe(1);
    await act(async () =>
      emit('notifications', 'UPDATE', {
        ...notification('one'),
        read_at: 'now',
      })
    );
    expect(badge).toBe(1);
    await act(async () => emit('notifications', 'UPDATE', { id: 'one' }));
    expect(badge).toBe(1);
    await act(async () => emit('notifications', 'DELETE', { id: 'two' }));
    expect(badge).toBe(0);
  });
  it('invalidates a notification count being fetched when a read arrives', async () => {
    tables.notifications = [notification('one')];
    const release = hold('notifications');
    await render();
    await act(async () => {
      emit('notifications', 'UPDATE', {
        ...notification('one'),
        read_at: 'now',
      });
      release();
    });
    expect(badge).toBe(0);
  });
  it('refreshes on subscription readiness to close the initial load gap', async () => {
    await render();
    tables.notifications.push(notification('between'));
    tables.conversations.push({
      id: 'between',
      account_id: 'A',
      unread_count: 1,
    });
    await act(async () =>
      channels.forEach((channel) => channel.status?.('SUBSCRIBED'))
    );
    expect(total).toBe(1);
    expect(badge).toBe(1);
  });
  it('returns empty badges after signout and ignores in-flight queries', async () => {
    tables.conversations = [{ id: 'a', account_id: 'A', unread_count: 1 }];
    tables.notifications = [notification('a')];
    await render();
    expect(total).toBe(1);
    expect(badge).toBe(1);
    h.accountId = null;
    h.userId = null;
    await render();
    expect(total).toBe(0);
    expect(badge).toBe(0);
  });
});
describe('notification page mutations', () => {
  it('marks all read only for the current recipient and workspace', async () => {
    withPage = true;
    tables.notifications = [
      notification('mine'),
      notification('foreign', 'B'),
      notification('other-user', 'A', 'teammate'),
    ];
    await render();
    const button = Array.from(host.querySelectorAll('button')).find((item) =>
      item.textContent?.includes('markAllRead')
    )!;
    await act(async () => button.click());
    await flush();
    expect(tables.notifications.map((item) => Boolean(item.read_at))).toEqual([
      true,
      false,
      false,
    ]);
    expect(writes[0].filters).toEqual(
      expect.arrayContaining([
        ['eq', 'account_id', 'A'],
        ['eq', 'user_id', 'user'],
        ['eq', 'read_at', null],
      ])
    );
  });
  it('scopes a single read and retains Inbox navigation', async () => {
    withPage = true;
    tables.notifications = [notification('mine'), notification('foreign', 'B')];
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('li button')!.click()
    );
    await flush();
    expect(writes[0].filters).toEqual(
      expect.arrayContaining([
        ['eq', 'id', 'mine'],
        ['eq', 'account_id', 'A'],
        ['eq', 'user_id', 'user'],
      ])
    );
    expect(h.push).toHaveBeenCalledWith('/inbox?c=conversation-mine');
  });
  it('does not show old list results or complete an old mutation in the new workspace', async () => {
    withPage = true;
    tables.notifications = [
      notification('A-notification'),
      notification('B-notification', 'B'),
    ];
    await render();
    const release = hold('notifications', 'update');
    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((item) => item.textContent?.includes('markAllRead'))!
        .click();
    });
    h.accountId = 'B';
    await render();
    expect(host.textContent).toContain('B-notification');
    expect(host.textContent).not.toContain('A-notification');
    await act(async () => release());
    expect(tables.notifications[1].read_at).toBeNull();
    expect(host.textContent).toContain('B-notification');
  });
});
