import type { Message } from '@/types';
import { receiveInboxMessage } from './message-state';

export const TEMP_MESSAGE_PREFIX = 'temp-';

let tempCounter = 0;

export function newTempMessageId(now: number = Date.now()): string {
  tempCounter += 1;
  return `${TEMP_MESSAGE_PREFIX}${now}-${tempCounter}`;
}

export function isTempMessage(message: Pick<Message, 'id'>): boolean {
  return message.id.startsWith(TEMP_MESSAGE_PREFIX);
}

function createdAtMs(message: Pick<Message, 'created_at'>): number {
  return new Date(message.created_at).getTime();
}

function unmatchedTemps(temps: Message[], fetched: Message[]): Message[] {
  return temps.filter(
    (temp) =>
      !fetched.some(
        (row) =>
          row.id === temp.id ||
          Boolean(temp.message_id && row.message_id === temp.message_id)
      )
  );
}

export function mergeFetchedPage(
  prev: Message[],
  fetched: Message[],
  conversationId: string
): Message[] {
  const local = prev.filter((m) => m.conversation_id === conversationId);
  const temps = local.filter(isTempMessage);
  const localReal = local.filter((m) => !isTempMessage(m));
  if (fetched.length === 0) {
    return [...localReal, ...unmatchedTemps(temps, fetched)];
  }

  const fetchedIds = new Set(fetched.map((m) => m.id));
  const oldestFetched = createdAtMs(fetched[0]);
  const newestFetched = createdAtMs(fetched[fetched.length - 1]);
  const overlapsLocal = localReal.some((m) => fetchedIds.has(m.id));

  const olderKept = overlapsLocal
    ? localReal.filter(
        (m) => !fetchedIds.has(m.id) && createdAtMs(m) < oldestFetched
      )
    : [];
  const newerKept = localReal.filter(
    (m) => !fetchedIds.has(m.id) && createdAtMs(m) > newestFetched
  );

  const reconciled = fetched.map((row) => {
    const current = localReal.find((item) => item.id === row.id);
    return current ? receiveInboxMessage([current], row)[0] : row;
  });
  return [
    ...olderKept,
    ...reconciled,
    ...newerKept,
    ...unmatchedTemps(temps, fetched),
  ];
}

export function prependOlderMessages(
  prev: Message[],
  older: Message[]
): Message[] {
  const known = new Set(prev.map((m) => m.id));
  const fresh = older.filter((m) => !known.has(m.id));
  return fresh.length === 0 ? prev : [...fresh, ...prev];
}
