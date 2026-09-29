import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveConnection: vi.fn(),
  loadStepsTree: vi.fn(),
  replaceSteps: vi.fn(),
  existing: null as Record<string, unknown> | null,
  updatePayloads: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: vi.fn(),
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))

vi.mock('@/lib/whatsapp/connection-resolver', () => {
  class WhatsAppConnectionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message)
    }
  }
  return {
    WhatsAppConnectionError,
    resolveWhatsAppConnection: mocks.resolveConnection,
  }
})

vi.mock('@/lib/automations/steps-tree', () => ({
  loadStepsTree: mocks.loadStepsTree,
  replaceSteps: mocks.replaceSteps,
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'automations') throw new Error(`unexpected table: ${table}`)
      const builder: Record<string, unknown> = {}
      builder.select = vi.fn(() => builder)
      builder.update = vi.fn((payload: Record<string, unknown>) => {
        mocks.updatePayloads.push(payload)
        return builder
      })
      builder.eq = vi.fn(() => builder)
      builder.maybeSingle = vi.fn(async () => ({ data: mocks.existing, error: null }))
      builder.then = (
        resolve: (value: { data: null; error: null }) => unknown,
      ) => Promise.resolve({ data: null, error: null }).then(resolve)
      return builder
    },
  }),
}))

import { PATCH } from './route'

const account = {
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  supabase: {},
}
const params = { params: Promise.resolve({ id: 'automation-1' }) }

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/automations/automation-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/automations/[id] WhatsApp dependency', () => {
  beforeEach(() => {
    mocks.requireRole.mockReset().mockResolvedValue(account)
    mocks.resolveConnection.mockReset().mockResolvedValue({ id: 'connection-1' })
    mocks.loadStepsTree.mockReset().mockResolvedValue([
      { step_type: 'add_tag', step_config: { tag_id: 'tag-1' } },
    ])
    mocks.replaceSteps.mockReset().mockResolvedValue(null)
    mocks.existing = {
      id: 'automation-1',
      user_id: 'user-1',
      account_id: 'account-1',
      whatsapp_config_id: 'connection-1',
      is_active: true,
      trigger_type: 'new_contact_created',
      trigger_config: {},
    }
    mocks.updatePayloads = []
  })

  it('can explicitly remove whatsapp_config_id from an active CRM-only automation', async () => {
    const response = await PATCH(request({ whatsapp_config_id: null }), params)

    expect(response.status).toBe(200)
    expect(mocks.resolveConnection).not.toHaveBeenCalled()
    expect(mocks.updatePayloads).toContainEqual({ whatsapp_config_id: null })
  })

  it('does not allow a foreign-workspace connection', async () => {
    const { WhatsAppConnectionError } = await import('@/lib/whatsapp/connection-resolver')
    mocks.resolveConnection.mockRejectedValueOnce(new WhatsAppConnectionError(
      'not_found',
      'WhatsApp connection not found for this workspace',
      404,
    ))

    const response = await PATCH(request({
      whatsapp_config_id: 'foreign-connection',
    }), params)

    expect(response.status).toBe(404)
    expect(mocks.updatePayloads).toHaveLength(0)
  })
})
