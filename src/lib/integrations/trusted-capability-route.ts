import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  scopeCapabilityRoute,
  type CapabilityRoute,
  type TrustedIntegrationBinding,
} from '@/lib/integrations/capability-contract';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads a trusted, account-scoped binding from current CRM tables. Only the
 * authenticated CRM backend may call this after authorizing account access.
 * Do not accept provider host IDs, group IDs or credentials from the model.
 *
 * This code depends on migration 94 and is not invoked from existing send paths.
 */
export async function loadTrustedCapabilityRoute(
  input: {
    accountId: string;
    integrationId: string;
    crmPropertyIds: string[];
  },
  db: SupabaseClient = supabaseAdmin()
): Promise<CapabilityRoute> {
  if (
    !uuid.test(input.accountId) ||
    !uuid.test(input.integrationId) ||
    !Array.isArray(input.crmPropertyIds) ||
    !input.crmPropertyIds.length ||
    input.crmPropertyIds.some((id) => typeof id !== 'string' || !uuid.test(id))
  ) {
    return { ok: false, reason: 'invalid_binding' };
  }
  const { data: integration, error: integrationError } = await db
    .from('pms_integrations')
    .select('id,account_id,provider,external_account_id,status,capability_config_version')
    .eq('id', input.integrationId)
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (
    integrationError || !integration ||
    integration.account_id !== input.accountId ||
    integration.id !== input.integrationId ||
    integration.status !== 'connected'
  ) {
    return { ok: false, reason: 'invalid_binding' };
  }

  const { data: properties, error: propertiesError } = await db
    .from('pms_properties')
    .select('id,account_id,pms_integration_id,external_property_id,status')
    .eq('account_id', input.accountId)
    .eq('pms_integration_id', input.integrationId)
    .in('id', [...new Set(input.crmPropertyIds)]);

  if (propertiesError || !properties) {
    return { ok: false, reason: 'invalid_binding' };
  }
  const binding: TrustedIntegrationBinding = {
    accountId: input.accountId,
    integrationId: input.integrationId,
    provider: integration.provider,
    externalAccountId: integration.external_account_id,
    configVersion: Number(integration.capability_config_version),
    properties: properties.map((property) => ({
      crmPropertyId: property.id,
      externalPropertyId: property.external_property_id,
      enabled:
        property.account_id === input.accountId &&
        property.pms_integration_id === input.integrationId &&
        property.status === 'active',
    })),
  };
  return scopeCapabilityRoute(binding, input.crmPropertyIds);
}
