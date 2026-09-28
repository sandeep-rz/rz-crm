-- Provider-neutral PMS reservation projection foundation.
-- Inbound webhook receipt/provisioning tables are intentionally unchanged.

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_id_account_id_key UNIQUE (id, account_id);

-- Required so a reservation cannot pair a property from one integration with
-- an integration row from another workspace/provider.
ALTER TABLE public.pms_properties
  ADD CONSTRAINT pms_properties_id_integration_account_key
  UNIQUE (id, pms_integration_id, account_id);

CREATE TABLE public.pms_contact_external_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  pms_integration_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  external_guest_id TEXT NOT NULL CHECK (length(btrim(external_guest_id)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT pms_contact_external_identities_integration_account_fkey
    FOREIGN KEY (pms_integration_id, account_id)
    REFERENCES public.pms_integrations(id, account_id) ON DELETE CASCADE,
  CONSTRAINT pms_contact_external_identities_contact_account_fkey
    FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts(id, account_id) ON DELETE CASCADE,
  CONSTRAINT pms_contact_external_identities_unique_guest
    UNIQUE (pms_integration_id, external_guest_id)
);

CREATE INDEX pms_contact_external_identities_account_idx
  ON public.pms_contact_external_identities (account_id);

CREATE TABLE public.pms_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  pms_integration_id UUID NOT NULL,
  pms_property_id UUID NOT NULL,
  contact_id UUID,
  external_reservation_id TEXT NOT NULL CHECK (length(btrim(external_reservation_id)) > 0),
  external_guest_id TEXT
    CHECK (external_guest_id IS NULL OR length(btrim(external_guest_id)) > 0),
  external_listing_id TEXT,
  reservation_code TEXT,
  status TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  check_in DATE,
  check_out DATE,
  adults INTEGER,
  children INTEGER,
  infants INTEGER,
  pets INTEGER,
  occupancy_total INTEGER,
  channel_code TEXT,
  channel_name TEXT,
  total_amount NUMERIC,
  paid_amount NUMERIC,
  balance_due NUMERIC,
  currency TEXT,
  payment_status TEXT,
  external_created_at TIMESTAMPTZ,
  external_updated_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT pms_reservations_integration_account_fkey
    FOREIGN KEY (pms_integration_id, account_id)
    REFERENCES public.pms_integrations(id, account_id) ON DELETE CASCADE,
  CONSTRAINT pms_reservations_property_account_fkey
    FOREIGN KEY (pms_property_id, pms_integration_id, account_id)
    REFERENCES public.pms_properties(id, pms_integration_id, account_id) ON DELETE CASCADE,
  CONSTRAINT pms_reservations_contact_account_fkey
    FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts(id, account_id),
  CONSTRAINT pms_reservations_contact_fkey
    FOREIGN KEY (contact_id)
    REFERENCES public.contacts(id) ON DELETE SET NULL,
  CONSTRAINT pms_reservations_unique_external
    UNIQUE (pms_integration_id, external_reservation_id),
  CONSTRAINT pms_reservations_nonnegative_occupancy
    CHECK (adults IS NULL OR adults >= 0)
);

CREATE INDEX pms_reservations_account_updated_idx
  ON public.pms_reservations (account_id, updated_at DESC);
CREATE INDEX pms_reservations_property_status_idx
  ON public.pms_reservations (pms_property_id, status);
CREATE INDEX pms_reservations_contact_idx
  ON public.pms_reservations (contact_id) WHERE contact_id IS NOT NULL;

CREATE TRIGGER set_pms_contact_external_identities_updated_at
  BEFORE UPDATE ON public.pms_contact_external_identities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_pms_reservations_updated_at
  BEFORE UPDATE ON public.pms_reservations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.pms_contact_external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pms_reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY pms_contact_external_identities_select_member
  ON public.pms_contact_external_identities FOR SELECT TO authenticated
  USING (public.is_account_member(account_id));
CREATE POLICY pms_reservations_select_member
  ON public.pms_reservations FOR SELECT TO authenticated
  USING (public.is_account_member(account_id));

REVOKE ALL ON public.pms_contact_external_identities FROM anon, authenticated;
REVOKE ALL ON public.pms_reservations FROM anon, authenticated;
GRANT SELECT ON public.pms_contact_external_identities TO authenticated;
GRANT SELECT ON public.pms_reservations TO authenticated;
GRANT ALL ON public.pms_contact_external_identities TO service_role;
GRANT ALL ON public.pms_reservations TO service_role;

COMMENT ON TABLE public.pms_contact_external_identities IS
  'Integration-scoped PMS guest identity mapping to an account contact; provider is derived from pms_integrations.';
COMMENT ON COLUMN public.pms_contact_external_identities.external_guest_id IS
  'Stable provider guest id only; never derive from name, email, or phone.';
COMMENT ON COLUMN public.pms_reservations.external_guest_id IS
  'Nullable canonical provider guest id; remains null when the PMS does not provide one.';
COMMENT ON TABLE public.pms_reservations IS
  'Integration-scoped normalized PMS reservation projection; provider is derived from pms_integrations and populated by a future sync pipeline.';
