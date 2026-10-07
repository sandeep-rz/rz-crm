import { expect, it, vi } from 'vitest';
import { loadEnvConfig } from '@next/env';
import { createClient } from '@supabase/supabase-js';
import { executeAutomationStep } from './engine';
import { loadReservationAutomationContext } from './pms-context';
import type { Automation, AutomationStep } from '@/types';
const h = vi.hoisted(() => ({ db: null as unknown, send: vi.fn() }));
vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.db }));
vi.mock('./meta-send', () => ({
  engineSendTemplate: h.send,
  engineSendText: vi.fn(),
  engineSendInteractive: vi.fn(),
}));
// Dry-run conversation resolution is read-only and never loads decrypted credentials.
vi.mock('@/lib/whatsapp/connection-resolver', async (original) => ({
  ...(await original<object>()),
  resolveWhatsAppConnection: vi.fn(async (_db, input) => ({
    id: input.connectionId,
  })),
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationForContact: vi.fn(async () => ({
    conversationId: 'dry-run-no-persistence',
  })),
}));
import { TemplatePreparationError } from '@/lib/message-preparation/errors';
vi.mock('server-only', () => ({}));

/** Explicit DEV-only, read-only preparation. Never print prepared values or send a message. */
it.skipIf(process.env.RGCRM_SEMANTIC_AUTOMATION_DEV_TEST !== '1')(
  'executes the automation semantic branch against real DEV PMS, stopping at the sender boundary',
  async () => {
    const previousMode = process.env.NODE_ENV;
    vi.stubEnv('NODE_ENV', 'development');
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} }, true);
    vi.stubEnv('NODE_ENV', previousMode);
    const pmsHost = new URL(process.env.RZ_PMS_API_BASE_URL!).hostname;
    expect(pmsHost).toBe('dev-api.rukiyezara.com');
    const dbHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname;
    const actualFetch = globalThis.fetch;
    let pmsCalls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url, init) => {
        const target = new URL(url instanceof Request ? url.url : String(url));
        if (target.hostname === pmsHost) {
          if (
            init?.method !== 'POST' ||
            target.pathname !== '/v1/integrations/rz-crm/variables/resolve'
          )
            throw new Error('Unexpected PMS dry-run request');
          pmsCalls++;
        } else if (
          target.hostname !== dbHost ||
          (init?.method && init.method !== 'GET')
        ) {
          throw new Error(
            'Dry-run permits only CRM reads and the PMS bulk resolver'
          );
        }
        return actualFetch(url, init);
      });
    try {
      const db = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (url, init) =>
              fetch(url, { ...init, signal: AbortSignal.timeout(5000) }),
          },
        }
      );
      const integrations = await db
        .from('pms_integrations')
        .select('id,account_id')
        .eq('provider', 'rukiye_zara')
        .eq('status', 'connected')
        .contains('metadata', { environment: 'dev' })
        .limit(1);
      expect(integrations.error).toBeNull();
      expect(integrations.data?.length).toBe(1);
      const integration = integrations.data![0];
      const templates = await db
        .from('message_templates')
        .select('id,semantic_variable_mapping,header_type')
        .eq('account_id', integration.account_id)
        .eq('template_origin', 'rgcrm')
        .eq('status', 'APPROVED')
        .eq('variable_configuration_status', 'configured')
        .limit(10);
      expect(templates.error).toBeNull();
      const selected = templates.data?.find(
        (t) =>
          (!t.header_type || t.header_type === 'text') &&
          Array.isArray(t.semantic_variable_mapping) &&
          t.semantic_variable_mapping.length > 0
      );
      expect(
        selected,
        'A real approved, configured RGCRM semantic template is required; the dry-run creates no fixtures in DEV.'
      ).toBeDefined();
      const properties = await db
        .from('pms_properties')
        .select('id')
        .eq('account_id', integration.account_id)
        .eq('pms_integration_id', integration.id)
        .eq('status', 'active')
        .limit(1);
      expect(properties.error).toBeNull();
      expect(properties.data?.length).toBe(1);
      const reservations = await db
        .from('pms_reservations')
        .select('id,contact_id')
        .eq('account_id', integration.account_id)
        .not('contact_id', 'is', null)
        .eq('pms_integration_id', integration.id)
        .eq('pms_property_id', properties.data![0].id)
        .in('metadata->>source_type', ['bookings', 'pms_bookings'])
        .limit(1);
      expect(reservations.error).toBeNull();
      expect(reservations.data?.length).toBe(1);
      h.db = db;
      h.send.mockResolvedValue({ whatsapp_message_id: 'dry-run-no-send' });
      const reservation = await loadReservationAutomationContext(
        reservations.data![0].id,
        integration.account_id
      );
      expect(reservation?.contact_id).toBeTruthy();
      await executeAutomationStep(
        {
          id: 'dry-run-step',
          step_type: 'send_template',
          step_config: { template_id: selected!.id },
        } as AutomationStep,
        {
          automation: {
            id: 'dry-run-automation',
            account_id: integration.account_id,
            user_id: 'dry-run-no-writes',
          } as Automation,
          contactId: reservation!.contact_id,
          context: { reservation: reservation! },
          parentStepId: null,
          branch: null,
          startPosition: 0,
          logId: null,
          triggerEvent: 'reservation_confirmed',
          triggerJobExecution: false,
        }
      );
      expect(pmsCalls).toBe(1);
      expect(h.send).toHaveBeenCalledTimes(1);
      const args = h.send.mock.calls[0][0];
      expect(args.templatePayload.components?.length).toBeGreaterThan(0);
      console.info(
        'DEV semantic automation dry-run verified (values omitted)',
        {
          name: args.templatePayload.name,
          language: args.templatePayload.language.code,
          connectionId: args.connectionId,
          pmsCalls,
          positions: args.preparedTemplate.mapping.map(
            (m: {
              component: string;
              position: number;
              button_index?: number;
            }) => ({
              component: m.component,
              position: m.position,
              buttonIndex: m.button_index,
            })
          ),
          components: args.templatePayload.components?.map(
            (c: {
              type: string;
              parameters: { type: string }[];
              index?: string;
            }) => ({
              type: c.type,
              index: c.index,
              parameterCount: c.parameters.length,
              parameterTypes: c.parameters.map((p) => p.type),
            })
          ),
        }
      );
    } catch (error) {
      if (error instanceof TemplatePreparationError) {
        console.info('DEV preparation failure (values omitted)', {
          code: error.code,
          pmsCalls,
          senderCalls: h.send.mock.calls.length,
          retryable: error.retryable,
          diagnostics: error.diagnostics,
        });
        expect(h.send).not.toHaveBeenCalled();
        // Never hand Vitest an object containing runtime values or raw errors.
        throw new Error(`DEV preparation failed: ${error.code}`);
      }
      throw error;
    } finally {
      fetchSpy.mockRestore();
    }
  },
  45000
);
