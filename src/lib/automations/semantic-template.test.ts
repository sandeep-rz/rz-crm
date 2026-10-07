import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation, AutomationStep } from '@/types';
import type { PreparedTemplateMessage } from '@/lib/message-preparation/types';
import { TemplatePreparationError } from '@/lib/message-preparation/errors';
import { AutomationTemplateSendError } from './template-send-error';
import { executeAutomationStep, runAutomationForTrigger } from './engine';
import { buildMetaTemplateMessagePayload } from '@/lib/whatsapp/meta-template-payload';
import { validateStepsForActivation } from './validate';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const h = vi.hoisted(() => ({
  assemble: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  legacy: vi.fn(),
  connection: vi.fn(),
  conversation: vi.fn(),
  filters: [] as unknown[],
  log: {} as Record<string, unknown>,
  gate: 'started',
  conversationFound: true,
  steps: [] as AutomationStep[],
  nestedSteps: [] as AutomationStep[],
  automation: {} as Automation,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/whatsapp/meta-template-payload', async (original) => {
  const real =
    await original<typeof import('@/lib/whatsapp/meta-template-payload')>();
  return {
    ...real,
    buildMetaTemplateMessagePayload: (prepared: PreparedTemplateMessage) => {
      h.assemble(prepared);
      return real.buildMetaTemplateMessagePayload(prepared);
    },
  };
});
vi.mock('@/lib/message-preparation/prepare-template-message', () => ({
  prepareTemplateMessage: h.prepare,
}));
vi.mock('./meta-send', () => ({
  engineSendTemplate: h.send,
  engineSendText: vi.fn(),
  engineSendInteractive: vi.fn(),
}));
vi.mock('@/lib/message-variables', () => ({
  buildAndResolveMessageVariables: h.legacy,
}));
vi.mock('@/lib/whatsapp/connection-resolver', async (original) => ({
  ...(await original<object>()),
  resolveWhatsAppConnection: h.connection,
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationForContact: h.conversation,
}));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (name: string) => ({
      data:
        name === 'begin_pms_automation_execution'
          ? [{ automation_log_id: 'log', disposition: h.gate }]
          : null,
      error: null,
    }),
    from: (table: string) => {
      let update: Record<string, unknown> | undefined;
      let nested = false;
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          if (key === 'parent_step_id') nested = true;
          h.filters.push([table, key, value]);
          return q;
        },
        gte: () => q,
        order: () => q,
        is: () => q,
        insert: () => q,
        update: (value: Record<string, unknown>) => {
          update = value;
          return q;
        },
        maybeSingle: () => q,
        single: () => q,
        then: (resolve: (value: unknown) => unknown) => {
          if (update) Object.assign(h.log, update);
          const data =
            table === 'contacts'
              ? { id: 'recipient' }
              : table === 'automations'
                ? h.automation
                : table === 'automation_steps'
                  ? nested
                    ? h.nestedSteps
                    : h.steps
                  : table === 'automation_logs'
                    ? h.log
                    : table === 'conversations'
                      ? h.conversationFound
                        ? { id: 'conversation-template' }
                        : null
                      : null;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return q;
    },
  }),
}));
const templateId = '11111111-1111-4111-8111-111111111111';
const prepared: PreparedTemplateMessage = {
  template: {
    id: templateId,
    name: 'authoritative',
    language: 'en_GB',
    connectionId: 'template-connection',
    body_text: 'Hello {{1}} / {{2}}',
  },
  context: { reservationId: 'canonical-reservation' },
  resolvedVariables: {
    'contact.first_name': 'Reservation guest',
    'listing.name': '0',
  },
  mapping: [
    { component: 'BODY', position: 2, variable_key: 'listing.name' },
    { component: 'BODY', position: 1, variable_key: 'contact.first_name' },
  ],
};
const action = (
  config: Record<string, unknown> = { template_id: templateId }
) =>
  ({
    id: 'step',
    step_type: 'send_template',
    step_config: config,
    position: 0,
    parent_step_id: null,
  }) as AutomationStep;
const args = () =>
  ({
    automation: h.automation,
    contactId: 'recipient',
    context: {
      reservation: {
        reservation_id: 'canonical-reservation',
        external_reservation_id: 'external-not-canonical',
        property_id: 'property-not-reservation',
      } as never,
      conversation_id: 'wrong-connection',
    },
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: 'log',
    triggerEvent: 'reservation_confirmed',
    triggerJobExecution: true,
  }) as Parameters<typeof executeAutomationStep>[1];
beforeEach(() => {
  vi.resetAllMocks();
  h.filters = [];
  h.gate = 'started';
  h.conversationFound = true;
  h.log = { id: 'log', status: 'processing', steps_executed: [] };
  h.automation = {
    id: 'automation',
    account_id: 'account',
    user_id: 'author',
    is_active: true,
    trigger_type: 'reservation_confirmed',
    trigger_config: {},
    whatsapp_config_id: 'automation-connection',
  } as Automation;
  h.steps = [action()];
  h.nestedSteps = [];
  h.prepare.mockResolvedValue(structuredClone(prepared));
  h.send.mockResolvedValue({ whatsapp_message_id: 'meta-id' });
  h.connection.mockResolvedValue({ id: 'template-connection' });
  h.conversation.mockResolvedValue({ conversationId: 'conversation-template' });
});
describe('semantic automation execution', () => {
  it('prepares once with only canonical reservation and account/template identities', async () => {
    await executeAutomationStep(action(), args());
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith({
      accountId: 'account',
      templateId,
      context: { reservationId: 'canonical-reservation' },
    });
    expect(h.legacy).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({
      contactId: 'recipient',
      connectionId: 'template-connection',
      templateName: 'authoritative',
      language: 'en_GB',
      conversationId: 'conversation-template',
      templatePayload: buildMetaTemplateMessagePayload(prepared),
    });
  });
  it('passes the prepared result once to the existing assembler', async () => {
    await executeAutomationStep(action(), args());
    expect(h.assemble).toHaveBeenCalledExactlyOnceWith(prepared);
  });
  it('repeated canonical variables retain all compiled occurrence positions', async () => {
    h.prepare.mockResolvedValue({
      ...prepared,
      mapping: [
        { component: 'BODY', position: 1, variable_key: 'contact.first_name' },
        { component: 'BODY', position: 2, variable_key: 'contact.first_name' },
      ],
    });
    await executeAutomationStep(action(), args());
    expect(
      h.send.mock.calls[0][0].templatePayload.components[0].parameters
    ).toEqual([
      { type: 'text', text: 'Reservation guest' },
      { type: 'text', text: 'Reservation guest' },
    ]);
  });
  it('a retryable failure sends nothing until a later execution succeeds', async () => {
    h.prepare.mockRejectedValueOnce(
      new TemplatePreparationError('runtime_provider_failure', {}, true)
    );
    await expect(executeAutomationStep(action(), args())).rejects.toMatchObject(
      { retryable: true }
    );
    expect(h.send).not.toHaveBeenCalled();
    await executeAutomationStep(action(), args());
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.prepare).toHaveBeenCalledTimes(2);
  });
  it('does not log resolved values during successful execution', async () => {
    const log = vi.spyOn(console, 'log');
    const info = vi.spyOn(console, 'info');
    const error = vi.spyOn(console, 'error');
    try {
      await executeAutomationStep(action(), args());
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      info.mockRestore();
      error.mockRestore();
    }
  });
  it('uses runtime values with numeric parameter ordering and preserves zero', async () => {
    await executeAutomationStep(action(), args());
    expect(
      h.send.mock.calls[0][0].templatePayload.components[0].parameters
    ).toEqual([
      { type: 'text', text: 'Reservation guest' },
      { type: 'text', text: '0' },
    ]);
  });
  it('chooses template connection instead of automation or incoming conversation', async () => {
    await executeAutomationStep(action(), args());
    expect(h.connection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ connectionId: 'template-connection' })
    );
    expect(h.filters).toContainEqual([
      'conversations',
      'whatsapp_config_id',
      'template-connection',
    ]);
    expect(h.filters).not.toContainEqual([
      'conversations',
      'id',
      'wrong-connection',
    ]);
  });
  it.each(['template_name', 'language', 'variables', 'variable_mappings'])(
    'ignores stale action %s',
    async (field) => {
      await executeAutomationStep(
        action({
          template_id: templateId,
          [field]: field.includes('variable')
            ? { poison: 'approval sample' }
            : 'stale',
        }),
        args()
      );
      expect(h.send.mock.calls[0][0].templatePayload.name).toBe(
        'authoritative'
      );
      expect(h.legacy).not.toHaveBeenCalled();
    }
  );
  it('creates a conversation through the existing resolver when none exists', async () => {
    h.conversationFound = false;
    await executeAutomationStep(action(), args());
    expect(h.conversation).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'account',
      contactId: 'recipient',
      connectionId: 'template-connection',
    });
  });
  it('rejects missing canonical reservation before preparation or send', async () => {
    const input = args();
    input.context = { vars: { reservation_id: 'fake' } };
    await expect(executeAutomationStep(action(), input)).rejects.toMatchObject({
      code: 'invalid_input',
      retryable: false,
    });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it('requires a separate recipient', async () => {
    await expect(
      executeAutomationStep(action(), { ...args(), contactId: null })
    ).rejects.toMatchObject({ code: 'invalid_input', retryable: false });
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each([
    'template_not_found',
    'template_not_owned',
    'template_connection_invalid',
    'template_not_sendable',
    'template_not_configured',
    'invalid_semantic_mapping',
    'variable_missing',
    'variable_unsupported',
    'provider_payload_invalid',
    'unsupported_template_component',
  ] as const)('%s blocks sending', async (code) => {
    h.prepare.mockRejectedValue(new TemplatePreparationError(code));
    await expect(executeAutomationStep(action(), args())).rejects.toMatchObject(
      { code, retryable: false }
    );
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'preserves runtime/provider failure retryability %s',
    async (retryable) => {
      h.prepare.mockRejectedValue(
        new TemplatePreparationError('runtime_provider_failure', {}, retryable)
      );
      const result = await runAutomationForTrigger('automation', {
        accountId: 'account',
        triggerType: 'reservation_confirmed',
        contactId: 'recipient',
        context: args().context,
      });
      expect(result).toMatchObject({
        status: 'failed',
        errorMessage: 'runtime_provider_failure',
        retryable,
      });
      expect(h.send).not.toHaveBeenCalled();
    }
  );
  it('retains safe failure diagnostics without source values in run details', async () => {
    h.prepare.mockRejectedValue(
      new TemplatePreparationError(
        'runtime_provider_failure',
        {
          runtimeFailures: [
            {
              source: 'provider',
              code: 'PROVIDER_HTTP_ERROR',
              httpStatus: 403,
              variableKeys: ['contact.first_name'],
              retryable: false,
            },
          ],
        },
        false
      )
    );
    const result = await runAutomationForTrigger('automation', {
      accountId: 'account',
      triggerType: 'reservation_confirmed',
      contactId: 'recipient',
      context: args().context,
    });
    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage:
        'runtime_provider_failure; provider:PROVIDER_HTTP_ERROR HTTP=403',
    });
    expect(JSON.stringify(h.log)).not.toContain('Reservation guest');
  });
  it('assembler rejects corrupted preparation before any sender call', async () => {
    h.prepare.mockResolvedValue({ ...prepared, resolvedVariables: {} });
    await expect(executeAutomationStep(action(), args())).rejects.toMatchObject(
      { code: 'provider_payload_invalid' }
    );
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 429, 500, 503])(
    'sanitizes Meta HTTP %s and classifies retries',
    async (httpStatus) => {
      h.send.mockRejectedValue(
        new MetaApiError('SENSITIVE PROVIDER TEXT', { httpStatus, code: 100 })
      );
      const result = await runAutomationForTrigger('automation', {
        accountId: 'account',
        triggerType: 'reservation_confirmed',
        contactId: 'recipient',
        context: args().context,
      });
      expect(result?.retryable).toBe(httpStatus === 429 || httpStatus >= 500);
      expect(result?.errorMessage).not.toContain('SENSITIVE');
    }
  );
  it('does not retry a known successful send whose persistence failed', async () => {
    h.send.mockRejectedValue(
      new AutomationTemplateSendError(
        'meta_sent_message_persistence_failed',
        false
      )
    );
    const result = await runAutomationForTrigger('automation', {
      accountId: 'account',
      triggerType: 'reservation_confirmed',
      contactId: 'recipient',
      context: args().context,
    });
    expect(result).toMatchObject({ status: 'failed', retryable: false });
  });
  it.each(['already_completed', 'already_running'])(
    'existing execution gate %s prevents another send',
    async (gate) => {
      h.gate = gate;
      h.log.status = 'success';
      await runAutomationForTrigger(
        'automation',
        {
          accountId: 'account',
          triggerType: 'reservation_confirmed',
          contactId: 'recipient',
          context: args().context,
        },
        {
          triggerJobId: 'job',
          attemptCount: 1,
          expectedReservationUpdatedAt: 'version',
        }
      );
      expect(h.prepare).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }
  );
  it('nested semantic failure remains failed and stops subsequent root actions', async () => {
    h.steps = [
      {
        ...action(),
        id: 'condition',
        step_type: 'condition',
        step_config: { subject: 'message_content', value: 'yes' },
      },
      action(),
    ];
    h.nestedSteps = [action()];
    h.prepare.mockRejectedValue(
      new TemplatePreparationError('variable_missing')
    );
    const result = await runAutomationForTrigger('automation', {
      accountId: 'account',
      triggerType: 'reservation_confirmed',
      contactId: 'recipient',
      context: { ...args().context, message_text: 'yes' },
    });
    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      errorMessage: 'variable_missing',
    });
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('persists successful action result and provider identity through the existing log', async () => {
    const result = await runAutomationForTrigger('automation', {
      accountId: 'account',
      triggerType: 'reservation_confirmed',
      contactId: 'recipient',
      context: args().context,
    });
    expect(result?.status).toBe('success');
    expect(h.log.steps_executed).toEqual([
      expect.objectContaining({
        step_id: 'step',
        status: 'success',
        detail: 'template sent via Meta (meta-id)',
      }),
    ]);
  });
  it('legacy numeric variables retain existing sender arguments', async () => {
    await executeAutomationStep(
      action({
        template_name: 'legacy',
        variables: { '2': 'two', '1': 'one' },
      }),
      args()
    );
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.send.mock.calls[0][0]).toMatchObject({
      templateName: 'legacy',
      params: ['one', 'two'],
    });
    expect(h.send.mock.calls[0][0].templatePayload).toBeUndefined();
  });
  it.each(['reservation_created', 'before_checkin', 'after_checkout'])(
    'shared canonical context also supports %s',
    async (triggerEvent) => {
      await executeAutomationStep(action(), { ...args(), triggerEvent });
      expect(h.prepare).toHaveBeenCalledTimes(1);
    }
  );
  it('semantic validation requires identity without legacy name or mapping', () => {
    expect(
      validateStepsForActivation([
        {
          step_type: 'send_template',
          step_config: { template_id: templateId, variable_mappings: 'stale' },
        },
      ])
    ).toEqual([]);
  });
  it.each(['', null, 'wrong'])(
    'invalid semantic identity %s cannot fall back to a name',
    (template_id) => {
      expect(
        validateStepsForActivation([
          {
            step_type: 'send_template',
            step_config: { template_id, template_name: 'legacy' },
          },
        ])
      ).toEqual([expect.objectContaining({ path: 'steps[0].template_id' })]);
    }
  );
});
