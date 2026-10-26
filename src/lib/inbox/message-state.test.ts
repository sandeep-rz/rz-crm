import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  outgoingAcknowledgement,
  receiveInboxMessage,
  updateInboxMessage,
} from './message-state';

function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'temp-first',
    conversation_id: 'conversation',
    sender_type: 'agent',
    content_type: 'text',
    content_text: 'Hello',
    status: 'sending',
    created_at: '2026-10-27T10:00:00Z',
    ...patch,
  };
}
const response = {
  message_id: 'database-id',
  whatsapp_message_id: 'wamid.first',
};
const acknowledgement = () => outgoingAcknowledgement(response, true)!;
const persisted = (patch: Partial<Message> = {}) =>
  message({ ...acknowledgement(), ...patch });

describe('Inbox send confirmation', () => {
  it('stops sending on the HTTP acknowledgement without waiting for Realtime', () => {
    const rows = updateInboxMessage(
      [message()],
      'temp-first',
      acknowledgement()
    );
    expect(rows).toEqual([persisted()]);
    expect(rows[0].status).toBe('sent');
  });

  it('keeps all pending sends when a customer message arrives', () => {
    const pending = [message(), message({ id: 'temp-second' })];
    const incoming = message({
      id: 'incoming',
      sender_type: 'customer',
      status: 'sent',
    });
    expect(receiveInboxMessage(pending, incoming)).toEqual([
      ...pending,
      incoming,
    ]);
  });

  it('binds only the confirmed send even when several messages have identical text', () => {
    const other = message({ id: 'temp-second' });
    const unrelated = persisted({
      id: 'other-agent',
      message_id: 'wamid.other',
    });
    let rows = receiveInboxMessage([message(), other], unrelated);
    rows = updateInboxMessage(rows, 'temp-first', acknowledgement());
    expect(rows).toEqual([persisted(), other, unrelated]);
  });

  it.each(['delivered', 'read'] as const)(
    'deduplicates Realtime-first confirmation and preserves %s status',
    (status) => {
      const other = message({ id: 'temp-second' });
      let rows = receiveInboxMessage([message(), other], persisted({ status }));
      rows = updateInboxMessage(rows, 'temp-first', acknowledgement());
      expect(rows).toEqual([other, persisted({ status })]);
    }
  );

  it('deduplicates HTTP-first confirmation and repeated Realtime events', () => {
    let rows = updateInboxMessage([message()], 'temp-first', acknowledgement());
    rows = receiveInboxMessage(rows, persisted({ status: 'read' }));
    rows = receiveInboxMessage(rows, persisted());
    rows = updateInboxMessage(rows, 'temp-first', acknowledgement());
    expect(rows).toEqual([persisted({ status: 'read' })]);
  });

  it('does not regress confirmed delivery on a late HTTP failure', () => {
    let rows = receiveInboxMessage([message()], persisted({ status: 'read' }));
    rows = updateInboxMessage(rows, 'temp-first', acknowledgement());
    rows = updateInboxMessage(rows, 'database-id', { status: 'failed' });
    expect(rows).toEqual([persisted({ status: 'read' })]);
  });

  it('preserves terminal provider failure on a late sent acknowledgement', () => {
    let rows = receiveInboxMessage(
      [message()],
      persisted({ status: 'failed' })
    );
    rows = updateInboxMessage(rows, 'temp-first', acknowledgement());
    expect(rows).toEqual([persisted({ status: 'failed' })]);
  });

  it('does not match provider IDs from another conversation', () => {
    const other = persisted({ conversation_id: 'other-conversation' });
    const rows = updateInboxMessage(
      [message(), other],
      'temp-first',
      acknowledgement()
    );
    expect(rows).toEqual([persisted(), other]);
  });

  it('retains confirmed acceptance when persistence returns an HTTP error', () => {
    const patch = outgoingAcknowledgement(
      {
        delivery_state: 'accepted',
        whatsapp_message_id: 'wamid.first',
      },
      false
    );
    expect(
      updateInboxMessage([message()], 'temp-first', patch!)[0]
    ).toMatchObject({
      status: 'sent',
      message_id: 'wamid.first',
    });
  });

  it.each([
    { delivery_state: 'accepted' },
    { delivery_state: 'unknown', whatsapp_message_id: 'wamid.first' },
    { error: 'Forbidden' },
  ])(
    'does not invent confirmation for an unsuccessful response: %j',
    (payload) => {
      expect(outgoingAcknowledgement(payload, false)).toBeNull();
    }
  );

  it('uses the rendered template text returned by the server', () => {
    expect(
      outgoingAcknowledgement(
        { ...response, content_text: 'Your stay is ready' },
        true
      )
    ).toMatchObject({ content_text: 'Your stay is ready', status: 'sent' });
  });
});
