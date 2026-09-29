import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveConnection: vi.fn(),
  insertSteps: vi.fn(),
  insertedAutomation: null as Record<string, unknown> | null,
  insertPayloads: [] as Record<string, unknown>[],
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
  insertSteps: mocks.insertSteps,
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'automations') throw new Error(`unexpected table: ${table}`)
      const builder = {
        insert: (payload: Record<string, unknown>) => {
          mocks.insertPayloads.push(payload)
          return builder
        },
        select: () => builder,
        single: async () => ({ data: mocks.insertedAutomation, error: null }),
      }
      return builder
    },
  }),
}))

import { POST } from './route'

const account = {
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  supabase: {},
}

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/automations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function addTagBody(triggerType: string) {
  return {
    name: 'CRM only',
    trigger_type: triggerType,
    trigger_config: {},
    is_active: true,
    steps: [{ step_type: 'add_tag', step_config: { tag_id: 'tag-1' } }],
  }
}

describe('POST /api/automations WhatsApp dependency', () => {
  beforeEach(() => {
    mocks.requireRole.mockReset().mockResolvedValue(account)
    mocks.resolveConnection.mockReset().mockResolvedValue({ id: 'connection-1' })
    mocks.insertSteps.mockReset().mockResolvedValue(null)
    mocks.insertedAutomation = { id: 'automation-1' }
    mocks.insertPayloads = []
  })

  it.each(['new_contact_created', 'reservation_confirmed'])(
    'creates and activates a %s -> add_tag automation with zero connections',
    async (triggerType) => {
      const response = await POST(request(addTagBody(triggerType)))

      expect(response.status).toBe(201)
      expect(mocks.resolveConnection).not.toHaveBeenCalled()
      expect(mocks.insertPayloads[0]).toMatchObject({
        account_id: 'account-1',
        whatsapp_config_id: null,
        is_active: true,
      })
    },
  )

  it('rejects activation of a WhatsApp send automation with no connection', async () => {
    const response = await POST(request({
      name: 'Send welcome',
      trigger_type: 'new_contact_created',
      trigger_config: {},
      is_active: true,
      steps: [{
        step_type: 'send_template',
        step_config: { template_name: 'welcome' },
      }],
    }))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.issues).toContainEqual(expect.objectContaining({
      path: 'whatsapp_config_id',
    }))
    expect(mocks.resolveConnection).not.toHaveBeenCalled()
    expect(mocks.insertPayloads).toHaveLength(0)
  })

  it('keeps send-template creation working with an owned connection', async () => {
    const response = await POST(request({
      name: 'Send welcome',
      trigger_type: 'new_contact_created',
      trigger_config: {},
      is_active: true,
      whatsapp_config_id: 'connection-1',
      steps: [{
        step_type: 'send_template',
        step_config: { template_name: 'welcome' },
      }],
    }))

    expect(response.status).toBe(201)
    expect(mocks.resolveConnection).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'account-1',
      connectionId: 'connection-1',
    })
    expect(mocks.insertPayloads[0].whatsapp_config_id).toBe('connection-1')
  })

  it('rejects a foreign-workspace connection', async () => {
    const { WhatsAppConnectionError } = await import('@/lib/whatsapp/connection-resolver')
    mocks.resolveConnection.mockRejectedValueOnce(new WhatsAppConnectionError(
      'not_found',
      'WhatsApp connection not found for this workspace',
      404,
    ))

    const response = await POST(request({
      ...addTagBody('new_contact_created'),
      whatsapp_config_id: 'foreign-connection',
    }))

    expect(response.status).toBe(404)
    expect(mocks.insertPayloads).toHaveLength(0)
  })
})
