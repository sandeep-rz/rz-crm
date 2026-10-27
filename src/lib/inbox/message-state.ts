import type { Message, MessageStatus } from '@/types';

const rank: Record<MessageStatus, number> = {
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 0,
};
function merge(current: Message, patch: Partial<Message>): Message {
  let status = patch.status ?? current.status;
  if (
    current.status === 'failed' ||
    (status === 'failed' && rank[current.status] >= 2) ||
    (status !== 'failed' && rank[status] < rank[current.status])
  )
    status = current.status;
  return { ...current, ...patch, status };
}
function matches(message: Message, identity: Partial<Message>) {
  return (
    message.id === identity.id ||
    Boolean(message.message_id && message.message_id === identity.message_id)
  );
}
/** Realtime must never delete unrelated in-flight sends or guess by message text. */
export function receiveInboxMessage(
  messages: Message[],
  message: Message
): Message[] {
  const existing = messages.findIndex(
    (row) =>
      row.conversation_id === message.conversation_id && matches(row, message)
  );
  if (existing < 0) return [...messages, message];
  return messages.map((row, index) =>
    index === existing ? merge(row, message) : row
  );
}
/** Bind the exact optimistic bubble to the HTTP-confirmed provider/database IDs.
 * Both API-first and Realtime-first ordering converge to one canonical bubble. */
export function updateInboxMessage(
  messages: Message[],
  id: string,
  patch: Partial<Message>
): Message[] {
  const source = messages.find((row) => row.id === id);
  const canonical = messages.find(
    (row) =>
      row.id !== id &&
      matches(row, patch) &&
      (!source || row.conversation_id === source.conversation_id)
  );
  if (!source)
    return canonical
      ? messages.map((row) => (row === canonical ? merge(row, patch) : row))
      : messages;
  if (!canonical)
    return messages.map((row) => (row === source ? merge(row, patch) : row));
  const combined = merge({ ...source, ...canonical }, patch);
  return messages
    .filter((row) => row !== source)
    .map((row) => (row === canonical ? combined : row));
}
/** A provider acceptance is enough for 'sent', never for 'delivered' or 'read'. */
export function outgoingAcknowledgement(
  payload: Record<string, unknown>,
  ok: boolean
): Partial<Message> | null {
  const wamid =
    typeof payload.whatsapp_message_id === 'string' &&
    payload.whatsapp_message_id
      ? payload.whatsapp_message_id
      : undefined;
  if (!ok && !(payload.delivery_state === 'accepted' && wamid)) return null;
  return {
    status: 'sent',
    ...(typeof payload.message_id === 'string' && payload.message_id
      ? { id: payload.message_id }
      : {}),
    ...(wamid ? { message_id: wamid } : {}),
    ...(payload.template_snapshot &&
    typeof payload.template_snapshot === 'object'
      ? {
          template_snapshot:
            payload.template_snapshot as Message['template_snapshot'],
        }
      : {}),
    ...(typeof payload.content_text === 'string'
      ? { content_text: payload.content_text }
      : {}),
  };
}
