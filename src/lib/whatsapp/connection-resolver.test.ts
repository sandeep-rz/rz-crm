import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => `plain:${value}`,
}))

import { resolveWhatsAppConnection, WhatsAppConnectionError } from './connection-resolver'

type Row = Record<string, unknown>

function fakeDb(seed: Record<string, Row[]>): SupabaseClient {
  class Query implements PromiseLike<{ data: Row[]; error: null }> {
    private rows: Row[]
    constructor(table: string) { this.rows = [...(seed[table] ?? [])] }
    select() { return this }
    eq(key: string, value: unknown) {
      this.rows = this.rows.filter((row) => row[key] === value)
      return this
    }
    limit(count: number) { this.rows = this.rows.slice(0, count); return this }
    async maybeSingle() { return { data: this.rows[0] ?? null, error: null } }
    then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ data: this.rows, error: null }).then(onfulfilled, onrejected)
    }
  }
  return { from: (table: string) => new Query(table) } as unknown as SupabaseClient
}

const configs: Row[] = [
  { id: 'a', account_id: 'workspace-1', user_id: 'user-1', display_name: 'Reservations', is_primary: true, phone_number_id: '111', waba_id: 'waba-a', access_token: 'token-a', status: 'connected' },
  { id: 'b', account_id: 'workspace-1', user_id: 'user-1', display_name: 'Support', is_primary: false, phone_number_id: '222', waba_id: 'waba-b', access_token: 'token-b', status: 'connected' },
  { id: 'foreign', account_id: 'workspace-2', user_id: 'user-2', display_name: 'Foreign', is_primary: true, phone_number_id: '333', waba_id: 'waba-c', access_token: 'token-c', status: 'connected' },
]

describe('resolveWhatsAppConnection', () => {
  it('falls back to the existing primary connection', async () => {
    const result = await resolveWhatsAppConnection(fakeDb({ whatsapp_config: configs }), { accountId: 'workspace-1' })
    expect(result.id).toBe('a')
    expect(result.accessToken).toBe('plain:token-a')
  })

  it('uses an explicit owned connection before conversation fallbacks', async () => {
    const db = fakeDb({ whatsapp_config: configs, conversations: [{ id: 'conversation-a', account_id: 'workspace-1', whatsapp_config_id: 'a' }] })
    const result = await resolveWhatsAppConnection(db, { accountId: 'workspace-1', connectionId: 'b', conversationId: 'conversation-a' })
    expect(result.id).toBe('b')
  })

  it('uses the conversation connection when no explicit id is supplied', async () => {
    const db = fakeDb({ whatsapp_config: configs, conversations: [{ id: 'conversation-b', account_id: 'workspace-1', whatsapp_config_id: 'b' }] })
    const result = await resolveWhatsAppConnection(db, { accountId: 'workspace-1', conversationId: 'conversation-b' })
    expect(result.id).toBe('b')
  })

  it('uses the persisted broadcast connection for resume', async () => {
    const db = fakeDb({ whatsapp_config: configs, broadcasts: [{ id: 'broadcast-b', account_id: 'workspace-1', whatsapp_config_id: 'b' }] })
    const result = await resolveWhatsAppConnection(db, { accountId: 'workspace-1', entity: { type: 'broadcast', id: 'broadcast-b' } })
    expect(result.id).toBe('b')
  })

  it('rejects a connection id belonging to another workspace', async () => {
    await expect(resolveWhatsAppConnection(fakeDb({ whatsapp_config: configs }), {
      accountId: 'workspace-1', connectionId: 'foreign',
    })).rejects.toBeInstanceOf(WhatsAppConnectionError)
  })

  it('uses a human-safe fallback without exposing the Meta phone number id', async () => {
    const unnamed = configs.map((row) =>
      row.id === 'a' ? { ...row, display_name: null, phone_number_id: '123456789012345' } : row,
    )
    const result = await resolveWhatsAppConnection(fakeDb({ whatsapp_config: unnamed }), {
      accountId: 'workspace-1',
    })

    expect(result.displayName).toBe('WhatsApp connection')
    expect(result.displayName).not.toContain('123456789012345')
  })
})
