-- 048_pms_integrations.sql
-- Rukiye Zara CRM / WACRM fork
--
-- Generic PMS integration foundation.
-- No Rukiye-Zara-specific credentials, webhook secrets, or provisioning HTTP.
--
-- Model:
--   accounts (CRM workspace)
--      -> pms_integrations (one external PMS account/tenant connection)
--           -> pms_properties (external properties mapped into that workspace)
--
-- Depends on migrations 001-047.

BEGIN;

-- ============================================================================
-- 1. PMS INTEGRATIONS
-- ============================================================================

CREATE TABLE public.pms_integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  account_id UUID NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,

  -- Stable machine identifier, e.g. rukiye_zara, cloudbeds, custom.
  provider TEXT NOT NULL,

  -- Identifier of the connected business/account in the provider.
  -- For Rukiye Zara this can later hold the external host/business identifier.
  external_account_id TEXT NOT NULL,

  display_name TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'provisioning',
      'connected',
      'error',
      'suspended',
      'disconnected'
    )),

  -- Provider-neutral API/adapter version. Not a secret.
  integration_version TEXT NOT NULL DEFAULT 'v1',

  connected_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pms_integrations_provider_not_blank
    CHECK (btrim(provider) <> ''),

  CONSTRAINT pms_integrations_external_account_not_blank
    CHECK (btrim(external_account_id) <> ''),

  CONSTRAINT pms_integrations_version_not_blank
    CHECK (btrim(integration_version) <> ''),

  -- Idempotent provisioning: the same external PMS account cannot be attached
  -- twice to the same CRM workspace for the same provider.
  CONSTRAINT pms_integrations_account_provider_external_unique
    UNIQUE (account_id, provider, external_account_id),

  -- Required for account-safe composite foreign keys from child tables.
  CONSTRAINT pms_integrations_id_account_unique
    UNIQUE (id, account_id)
);

CREATE INDEX idx_pms_integrations_account_status
  ON public.pms_integrations(account_id, status);

CREATE INDEX idx_pms_integrations_provider_external
  ON public.pms_integrations(provider, external_account_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.pms_integrations;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON public.pms_integrations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.pms_integrations IS
  'Provider-neutral PMS connections owned by a CRM workspace. Credentials and provider-specific secrets are intentionally not stored here.';

COMMENT ON COLUMN public.pms_integrations.provider IS
  'Stable adapter/provider code such as rukiye_zara.';

COMMENT ON COLUMN public.pms_integrations.external_account_id IS
  'Provider-side business/account/tenant identifier, not a CRM account id.';

-- ============================================================================
-- 2. PMS PROPERTIES
-- ============================================================================

CREATE TABLE public.pms_properties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  account_id UUID NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,

  pms_integration_id UUID NOT NULL,

  -- Provider-side property identifier. Stored as text so numeric, UUID and
  -- alphanumeric PMS identifiers are all supported.
  external_property_id TEXT NOT NULL,

  name TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN (
      'active',
      'inactive',
      'suspended',
      'disconnected'
    )),

  initial_sync_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (initial_sync_status IN (
      'pending',
      'syncing',
      'completed',
      'failed'
    )),

  initial_sync_started_at TIMESTAMPTZ,
  initial_sync_completed_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_sync_error TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pms_properties_external_property_not_blank
    CHECK (btrim(external_property_id) <> ''),

  -- Guarantees the child belongs to the same CRM workspace as its integration.
  CONSTRAINT pms_properties_integration_account_fkey
    FOREIGN KEY (pms_integration_id, account_id)
    REFERENCES public.pms_integrations(id, account_id)
    ON DELETE CASCADE,

  -- One external property maps once inside a specific PMS integration.
  CONSTRAINT pms_properties_integration_external_unique
    UNIQUE (pms_integration_id, external_property_id),

  CONSTRAINT pms_properties_id_account_unique
    UNIQUE (id, account_id)
);

CREATE INDEX idx_pms_properties_account_status
  ON public.pms_properties(account_id, status);

CREATE INDEX idx_pms_properties_integration_status
  ON public.pms_properties(pms_integration_id, status);

CREATE INDEX idx_pms_properties_external_property
  ON public.pms_properties(external_property_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.pms_properties;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON public.pms_properties
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.pms_properties IS
  'Provider-neutral external PMS properties connected to a CRM workspace through pms_integrations.';

COMMENT ON COLUMN public.pms_properties.external_property_id IS
  'Property identifier in the external PMS. It is intentionally TEXT for cross-provider compatibility.';

-- ============================================================================
-- 3. ROW LEVEL SECURITY
--
-- Workspace members may read PMS connection/property state.
-- Only owner/admin may manually create/update/delete these rows from the CRM.
-- service_role is used by trusted provisioning code and bypasses RLS.
-- ============================================================================

ALTER TABLE public.pms_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pms_properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY pms_integrations_select
ON public.pms_integrations
FOR SELECT
TO authenticated
USING (public.is_account_member(account_id));

CREATE POLICY pms_integrations_insert
ON public.pms_integrations
FOR INSERT
TO authenticated
WITH CHECK (public.is_account_member(account_id, 'admin'));

CREATE POLICY pms_integrations_update
ON public.pms_integrations
FOR UPDATE
TO authenticated
USING (public.is_account_member(account_id, 'admin'))
WITH CHECK (public.is_account_member(account_id, 'admin'));

CREATE POLICY pms_integrations_delete
ON public.pms_integrations
FOR DELETE
TO authenticated
USING (public.is_account_member(account_id, 'admin'));

CREATE POLICY pms_properties_select
ON public.pms_properties
FOR SELECT
TO authenticated
USING (public.is_account_member(account_id));

CREATE POLICY pms_properties_insert
ON public.pms_properties
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_account_member(account_id, 'admin')
  AND EXISTS (
    SELECT 1
    FROM public.pms_integrations pi
    WHERE pi.id = pms_integration_id
      AND pi.account_id = pms_properties.account_id
  )
);

CREATE POLICY pms_properties_update
ON public.pms_properties
FOR UPDATE
TO authenticated
USING (public.is_account_member(account_id, 'admin'))
WITH CHECK (
  public.is_account_member(account_id, 'admin')
  AND EXISTS (
    SELECT 1
    FROM public.pms_integrations pi
    WHERE pi.id = pms_integration_id
      AND pi.account_id = pms_properties.account_id
  )
);

CREATE POLICY pms_properties_delete
ON public.pms_properties
FOR DELETE
TO authenticated
USING (public.is_account_member(account_id, 'admin'));

COMMIT;
