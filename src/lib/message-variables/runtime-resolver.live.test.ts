import { expect, it, vi } from 'vitest';
import { loadEnvConfig } from '@next/env';
import { createClient } from '@supabase/supabase-js';
vi.mock('server-only', () => ({}));
import { resolveRuntimeVariables } from './runtime-resolver';

/** Explicit opt-in, DEV host only, read-only. Never print resolved sensitive values. */
it.skipIf(process.env.RGCRM_RUNTIME_DEV_TEST !== '1')(
  'resolves a canonical connected DEV reservation through the real RZ PMS boundary',
  async () => {
    // Next deliberately skips .env.local under NODE_ENV=test. Load the DEV
    // configuration only for this explicitly opted-in integration check.
    const previousMode = process.env.NODE_ENV;
    vi.stubEnv('NODE_ENV', 'development');
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} }, true);
    vi.stubEnv('NODE_ENV', previousMode);
    expect(new URL(process.env.RZ_PMS_API_BASE_URL!).hostname).toBe(
      'dev-api.rukiyezara.com'
    );
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
    const { data: integrations, error: integrationError } = await db
      .from('pms_integrations')
      .select('id,account_id,metadata')
      .eq('provider', 'rukiye_zara')
      .eq('status', 'connected')
      .contains('metadata', { environment: 'dev' })
      .limit(1);
    expect(integrationError).toBeNull();
    expect(integrations?.length).toBe(1);
    const integration = integrations![0];
    const { data: properties, error: propertyError } = await db
      .from('pms_properties')
      .select('id')
      .eq('account_id', integration.account_id)
      .eq('pms_integration_id', integration.id)
      .eq('status', 'active')
      .limit(1);
    expect(propertyError).toBeNull();
    expect(properties?.length).toBe(1);
    const { data: reservations, error: reservationError } = await db
      .from('pms_reservations')
      .select('id,metadata')
      .eq('account_id', integration.account_id)
      .eq('pms_integration_id', integration.id)
      .eq('pms_property_id', properties![0].id)
      .in('metadata->>source_type', ['bookings', 'pms_bookings'])
      .limit(1);
    expect(reservationError).toBeNull();
    expect(reservations?.length).toBe(1);
    const keys = [
      'workspace.name',
      'contact.first_name',
      'property.name',
      'listing.check_in_time',
    ];
    const result = await resolveRuntimeVariables(
      {
        accountId: integration.account_id,
        context: { reservationId: reservations![0].id },
        variableKeys: keys,
      },
      { db }
    );
    console.info('DEV runtime boundary verification', {
      success: result.success,
      sourceType: reservations![0].metadata.source_type,
      statuses: Object.fromEntries(
        Object.entries(result.values).map(([key, item]) => [
          key,
          {
            status: item.status,
            source: item.source,
            hasValue: item.status === 'resolved' && item.value.length > 0,
          },
        ])
      ),
      failures: result.failures.map((item) => ({
        code: item.code,
        retryable: item.retryable,
        httpStatus: item.httpStatus,
        providerCode: item.providerCode,
      })),
    });
    expect(result.failures).toEqual([]);
    expect(result.success).toBe(true);
    expect(Object.keys(result.values).sort()).toEqual([...keys].sort());
    expect(result.values['workspace.name'].source).toBe('crm');
    expect(result.values['contact.first_name'].status).toBe('resolved');
    expect(result.values['property.name'].status).toBe('resolved');
  },
  30000
);
