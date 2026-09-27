-- 052_pms_webhook_events.sql
--
-- Durable, provider-neutral receipt ledger for inbound PMS domain events.
-- Webhook authentication remains application-side; only the trusted server
-- service role may create or mutate receipts.
-- Depends on migrations 043 and 048.

BEGIN;

CREATE TABLE public.pms_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,

  account_id UUID NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,

  pms_integration_id UUID NOT NULL,
  pms_property_id UUID NOT NULL,

  event_type TEXT NOT NULL,
  external_resource_id TEXT,
  occurred_at TIMESTAMPTZ,

  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),

  -- The first receiver pass records the authenticated event and marks that a
  -- later canonical PMS API read is required. It does not mutate CRM domain
  -- data from the webhook payload.
  payload JSONB,
  error_message TEXT,
  processed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pms_webhook_events_provider_not_blank
    CHECK (btrim(provider) <> ''),
  CONSTRAINT pms_webhook_events_external_event_not_blank
    CHECK (btrim(external_event_id) <> ''),
  CONSTRAINT pms_webhook_events_event_type_not_blank
    CHECK (btrim(event_type) <> ''),

  CONSTRAINT pms_webhook_events_provider_event_unique
    UNIQUE (provider, external_event_id),

  CONSTRAINT pms_webhook_events_integration_account_fkey
    FOREIGN KEY (pms_integration_id, account_id)
    REFERENCES public.pms_integrations(id, account_id)
    ON DELETE CASCADE,

  CONSTRAINT pms_webhook_events_property_account_fkey
    FOREIGN KEY (pms_property_id, account_id)
    REFERENCES public.pms_properties(id, account_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_pms_webhook_events_account_created
  ON public.pms_webhook_events(account_id, created_at DESC);

CREATE INDEX idx_pms_webhook_events_integration_status
  ON public.pms_webhook_events(pms_integration_id, status);

CREATE INDEX idx_pms_webhook_events_property_created
  ON public.pms_webhook_events(pms_property_id, created_at DESC);

DROP TRIGGER IF EXISTS set_pms_webhook_events_updated_at
  ON public.pms_webhook_events;

CREATE TRIGGER set_pms_webhook_events_updated_at
BEFORE UPDATE ON public.pms_webhook_events
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.pms_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY pms_webhook_events_select
ON public.pms_webhook_events
FOR SELECT
TO authenticated
USING (public.is_account_member(account_id));

-- Grants and policies are both explicit. Workspace members can inspect their
-- own receipt history; only the service role can write webhook state.
REVOKE ALL ON TABLE public.pms_webhook_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.pms_webhook_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.pms_webhook_events
  TO service_role;

COMMENT ON TABLE public.pms_webhook_events IS
  'Durable idempotency ledger for authenticated inbound PMS webhook events. Writes are service-role-only.';

COMMIT;
