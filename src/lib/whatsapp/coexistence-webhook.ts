import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const phone = (v: unknown) =>
  typeof v === 'string' && /^\+?[1-9]\d{6,14}$/.test(v)
    ? v.replace(/^\+/, '')
    : null;
const timestamp = (v: unknown) => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n < 253402300799
    ? new Date(n * 1000).toISOString()
    : null;
};
export const isCoexistenceField = (field: string) =>
  [
    'history',
    'smb_app_state_sync',
    'smb_message_echoes',
    'account_update',
  ].includes(field);

export function coexistenceRecords(
  field: string,
  input: unknown,
  time?: unknown
) {
  const v = obj(input);
  const records: Obj[] = [];
  const own = phone(obj(v.metadata).display_phone_number);
  const addMessage = (
    raw: unknown,
    peer: string | null,
    history: boolean,
    mediaOnly = false
  ) => {
    const m = obj(raw);
    const at = timestamp(m.timestamp);
    if (!peer || typeof m.id !== 'string' || !m.id || !at)
      throw new Error('Invalid Coexistence message identity.');
    const kind = String(m.type || 'unknown');
    const content = obj(m[kind]);
    const outbound = mediaOnly ? undefined : phone(m.from) === own;
    records.push({
      kind: 'message',
      peer,
      id: m.id,
      at,
      history,
      media_only: mediaOnly,
      outbound,
      type: [
        'image',
        'video',
        'audio',
        'document',
        'location',
        'interactive',
      ].includes(kind)
        ? kind
        : kind === 'sticker'
          ? 'image'
          : 'text',
      placeholder: kind === 'media_placeholder',
      text:
        typeof content.body === 'string'
          ? content.body
          : typeof content.caption === 'string'
            ? content.caption
            : kind === 'media_placeholder'
              ? '[Historical media unavailable]'
              : `[${kind}]`,
      media_id: typeof content.id === 'string' ? content.id : null,
      mime_type:
        typeof content.mime_type === 'string' ? content.mime_type : null,
      status: ['READ', 'PLAYED'].includes(String(obj(m.history_context).status))
        ? 'read'
        : obj(m.history_context).status === 'DELIVERED'
          ? 'delivered'
          : obj(m.history_context).status === 'ERROR'
            ? 'failed'
            : 'sent',
    });
  };
  if (field === 'smb_message_echoes') {
    if (!own) throw new Error('Missing Business app number.');
    for (const raw of arr(v.message_echoes)) {
      if (phone(obj(raw).from) !== own)
        throw new Error('Unexpected echo sender.');
      addMessage(raw, phone(obj(raw).to), false);
    }
  } else if (field === 'history') {
    for (const raw of arr(v.history)) {
      const h = obj(raw),
        meta = obj(h.metadata);
      for (const thread of arr(h.threads))
        for (const message of arr(obj(thread).messages)) {
          if (!own) throw new Error('Missing history business number.');
          addMessage(message, phone(obj(thread).id), true);
        }
      const denied = arr(h.errors).some((e) => obj(e).code === 2593109);
      const progress =
        typeof meta.progress === 'number'
          ? Math.max(0, Math.min(100, meta.progress))
          : null;
      records.push({
        kind: 'progress',
        denied,
        progress,
        phase: meta.phase,
        chunk_order: meta.chunk_order,
        error: !denied && arr(h.errors).length > 0,
      });
    }
    // Separate media payloads identify a pre-existing message. Do not create a
    // new conversation from their from field: it may be the business itself.
    for (const message of arr(v.messages))
      addMessage(message, phone(obj(message).from), true, true);
  } else if (field === 'smb_app_state_sync') {
    for (const raw of arr(v.state_sync)) {
      const s = obj(raw),
        c = obj(s.contact),
        at = timestamp(obj(s.metadata).timestamp),
        peer = phone(c.phone_number);
      if (s.type !== 'contact') continue;
      if (!at || !peer || !['add', 'remove'].includes(String(s.action)))
        throw new Error('Invalid app contact sync.');
      records.push({
        kind: 'contact',
        peer,
        at,
        removed: s.action === 'remove',
        name:
          typeof c.full_name === 'string'
            ? c.full_name.slice(0, 200)
            : typeof c.first_name === 'string'
              ? c.first_name.slice(0, 200)
              : null,
      });
    }
  } else if (
    field === 'account_update' &&
    ['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED'].includes(
      String(v.event)
    )
  ) {
    const at = timestamp(time);
    if (!at) throw new Error('Missing account lifecycle timestamp.');
    records.push({
      kind: 'lifecycle',
      event: v.event,
      at,
      phone: phone(v.phone_number),
      disconnection: obj(v.disconnection_info),
    });
  }
  return records;
}

/** Durable capture precedes 200 OK; only service-role SQL resolves tenancy.
 * Store bounded batches so a large history delivery never requires one long
 * application loop or causes normal inbound automations to run on old chats. */
export async function captureCoexistenceWebhook(
  db: SupabaseClient,
  body: unknown
) {
  const events: Obj[] = [];
  for (const raw of arr(obj(body).entry)) {
    const entry = obj(raw);
    for (const rawChange of arr(entry.changes)) {
      const change = obj(rawChange),
        field = String(change.field);
      if (!isCoexistenceField(field)) continue;
      const v = obj(change.value);
      const records = coexistenceRecords(field, v, entry.time);
      if (!records.length) continue;
      if (
        field !== 'account_update' &&
        !/^\d{1,30}$/.test(String(obj(v.metadata).phone_number_id ?? ''))
      )
        throw new Error('Missing Coexistence phone identifier.');
      const digest = createHash('sha256')
        .update(
          JSON.stringify({ waba: entry.id, field, value: v, time: entry.time })
        )
        .digest('hex');
      for (let offset = 0; offset < records.length; offset += 100) {
        events.push({
          waba: entry.id,
          phone_id: obj(v.metadata).phone_number_id ?? null,
          key: `${digest}:${offset}`,
          records: records.slice(offset, offset + 100),
        });
      }
    }
  }
  if (!events.length) return false;
  const { error } = await db.rpc('capture_whatsapp_coexistence_event', {
    p_events: events,
  });
  if (error) throw new Error('Coexistence capture failed.');
  return true;
}
export async function drainCoexistenceWebhook(db: SupabaseClient) {
  // SQL imports one small batch and commits its completion atomically. A
  // terminated after() callback cannot lose an acknowledged chunk.
  const { error } = await db.rpc('process_whatsapp_coexistence_event', {
    p_limit: 25,
  });
  if (error) throw new Error('Coexistence processing failed.');
}
