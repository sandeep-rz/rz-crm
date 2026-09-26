import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'

export type WhatsAppConnectionEntity =
  | { type: 'broadcast'; id: string }
  | { type: 'automation'; id: string }
  | { type: 'flow'; id: string }
  | { type: 'template'; id: string }

export interface ResolveWhatsAppConnectionInput {
  accountId: string
  connectionId?: string | null
  conversationId?: string | null
  entity?: WhatsAppConnectionEntity | null
}

export interface ResolvedWhatsAppConnection {
  id: string
  accountId: string
  userId: string
  displayName: string
  isPrimary: boolean
  phoneNumberId: string
  wabaId: string | null
  accessToken: string
  encryptedAccessToken: string
  status: string
}

export class WhatsAppConnectionError extends Error {
  readonly code: 'not_found' | 'not_configured' | 'invalid_credentials'
  readonly status: number

  constructor(
    code: WhatsAppConnectionError['code'],
    message: string,
    status: number,
  ) {
    super(message)
    this.name = 'WhatsAppConnectionError'
    this.code = code
    this.status = status
  }
}

const ENTITY_TABLE = {
  broadcast: 'broadcasts',
  automation: 'automations',
  flow: 'flows',
  template: 'message_templates',
} as const

/**
 * Resolve the one WhatsApp connection a server-side operation must use.
 * Priority is deliberately stable: explicit id, conversation, owning entity,
 * then the account primary. Every hop is account-scoped even for service-role
 * callers, so an id from another workspace can never select its credentials.
 */
export async function resolveWhatsAppConnection(
  db: SupabaseClient,
  input: ResolveWhatsAppConnectionInput,
): Promise<ResolvedWhatsAppConnection> {
  const { accountId } = input
  let connectionId = input.connectionId ?? null

  if (!connectionId && input.conversationId) {
    const { data, error } = await db
      .from('conversations')
      .select('whatsapp_config_id')
      .eq('id', input.conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) throw new WhatsAppConnectionError('not_found', 'Conversation not found', 404)
    connectionId = data?.whatsapp_config_id ?? null
  }

  if (!connectionId && input.entity) {
    const { data, error } = await db
      .from(ENTITY_TABLE[input.entity.type])
      .select('whatsapp_config_id')
      .eq('id', input.entity.id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error || !data) {
      throw new WhatsAppConnectionError('not_found', `${input.entity.type} not found`, 404)
    }
    connectionId = data.whatsapp_config_id ?? null
  }

  let query = db
    .from('whatsapp_config')
    .select('id, account_id, user_id, display_name, is_primary, phone_number_id, waba_id, access_token, status')
    .eq('account_id', accountId)

  query = connectionId
    ? query.eq('id', connectionId)
    : query.eq('is_primary', true)

  const { data: rows, error } = await query.limit(2)
  if (error) {
    throw new WhatsAppConnectionError('not_configured', 'Failed to load WhatsApp connection', 500)
  }
  const config = rows?.[0]
  if (!config) {
    throw new WhatsAppConnectionError(
      connectionId ? 'not_found' : 'not_configured',
      connectionId
        ? 'WhatsApp connection not found for this workspace'
        : 'No primary WhatsApp connection is configured for this workspace',
      connectionId ? 404 : 400,
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    throw new WhatsAppConnectionError(
      'invalid_credentials',
      'The selected WhatsApp connection credentials cannot be decrypted',
      500,
    )
  }

  return {
    id: config.id,
    accountId: config.account_id,
    userId: config.user_id,
    displayName: config.display_name || 'WhatsApp connection',
    isPrimary: Boolean(config.is_primary),
    phoneNumberId: config.phone_number_id,
    wabaId: config.waba_id ?? null,
    accessToken,
    encryptedAccessToken: config.access_token,
    status: config.status,
  }
}
