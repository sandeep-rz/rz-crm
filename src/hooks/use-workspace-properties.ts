'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  buildPropertyOptions,
  type PropertyIntegrationRow,
  type PropertyOption,
  type PropertySourceRow,
} from '@/lib/properties/property-context';

interface PropertyState {
  accountId: string | null;
  options: PropertyOption[];
  loading: boolean;
  integrations: WorkspaceIntegration[];
}

export interface WorkspaceIntegration extends PropertyIntegrationRow {
  status: string;
  last_sync_at: string | null;
}

export function useWorkspaceProperties(accountId: string | null) {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<PropertyState>({
    accountId: null,
    options: [],
    loading: true,
    integrations: [],
  });

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    const load = async () => {
      const [propertiesResult, integrationsResult] = await Promise.all([
        supabase
          .from('pms_properties')
          .select(
            'id, account_id, pms_integration_id, name, status, initial_sync_status'
          )
          .eq('account_id', accountId)
          .order('name'),
        supabase
          .from('pms_integrations')
          .select(
            'id, account_id, display_name, provider, status, last_sync_at'
          )
          .eq('account_id', accountId),
      ]);
      if (!active) return;
      const error = propertiesResult.error ?? integrationsResult.error;
      setState({
        accountId,
        options: error
          ? []
          : buildPropertyOptions(
              accountId,
              (propertiesResult.data ?? []) as PropertySourceRow[],
              (integrationsResult.data ?? []) as WorkspaceIntegration[]
            ),
        loading: false,
        integrations: error
          ? []
          : ((integrationsResult.data ?? []) as WorkspaceIntegration[]),
      });
    };
    void load();
    return () => {
      active = false;
    };
  }, [accountId, supabase]);

  return state.accountId === accountId
    ? state
    : { accountId, options: [], integrations: [], loading: Boolean(accountId) };
}
