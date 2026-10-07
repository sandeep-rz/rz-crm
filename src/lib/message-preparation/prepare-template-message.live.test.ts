import { expect, it, vi } from 'vitest';
import { loadEnvConfig } from '@next/env';
import { createClient } from '@supabase/supabase-js';
import { prepareTemplateMessage } from './prepare-template-message';
import { buildMetaTemplateMessagePayload } from '@/lib/whatsapp/meta-template-payload';
import { TemplatePreparationError } from './errors';
vi.mock('server-only', () => ({}));

/** Explicit DEV-only, read-only preparation. Never print prepared values or send a message. */
it.skipIf(process.env.RGCRM_TEMPLATE_PREPARATION_DEV_TEST !== '1')(
  'prepares a real approved semantic template and reservation without sending',
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
        .select('id,semantic_variable_mapping')
        .eq('account_id', integration.account_id)
        .eq('template_origin', 'rgcrm')
        .eq('status', 'APPROVED')
        .eq('variable_configuration_status', 'configured')
        .limit(10);
      expect(templates.error).toBeNull();
      const selected = templates.data?.find(
        (t) =>
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
        .select('id')
        .eq('account_id', integration.account_id)
        .eq('pms_integration_id', integration.id)
        .eq('pms_property_id', properties.data![0].id)
        .in('metadata->>source_type', ['bookings', 'pms_bookings'])
        .limit(1);
      expect(reservations.error).toBeNull();
      expect(reservations.data?.length).toBe(1);
      const prepared = await prepareTemplateMessage(
        {
          accountId: integration.account_id,
          templateId: selected!.id,
          context: { reservationId: reservations.data![0].id },
        },
        { db }
      );
      const payload = buildMetaTemplateMessagePayload(prepared);
      expect(pmsCalls).toBe(1);
      expect(payload.components?.length).toBeGreaterThan(0);
      console.info('DEV template preparation verified (values omitted)', {
        templateId: prepared.template.id,
        reservationId: prepared.context.reservationId,
        canonicalKeys: Object.keys(prepared.resolvedVariables),
        pmsCalls,
        components: payload.components?.map((c) => ({
          type: c.type,
          ...('index' in c ? { index: c.index } : {}),
          parameterTypes: c.parameters.map((p) => p.type),
          parameterCount: c.parameters.length,
        })),
      });
    } catch (error) {
      if (error instanceof TemplatePreparationError) {
        console.info('DEV preparation failure (values omitted)', {
          code: error.code,
          retryable: error.retryable,
          diagnostics: error.diagnostics,
        });
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
