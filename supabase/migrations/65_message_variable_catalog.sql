-- Provider-neutral semantic variables available to every CRM workspace.
-- Positional Meta template parameters and workspace custom fields are
-- deliberately outside this global catalog.

CREATE TABLE public.message_variable_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variable_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  data_type TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  resolver_key TEXT NOT NULL,
  preview_value TEXT,
  default_fallback TEXT,
  is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT message_variable_catalog_variable_key_unique
    UNIQUE (variable_key),
  CONSTRAINT message_variable_catalog_variable_key_format
    CHECK (variable_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT message_variable_catalog_resolver_key_format
    CHECK (resolver_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT message_variable_catalog_category_check
    CHECK (category IN ('contact', 'reservation', 'property', 'workspace')),
  CONSTRAINT message_variable_catalog_data_type_check
    CHECK (data_type IN ('text', 'phone', 'email', 'date', 'number', 'currency', 'url')),
  CONSTRAINT message_variable_catalog_source_scope_check
    CHECK (source_scope IN ('contact', 'reservation', 'property', 'workspace')),
  CONSTRAINT message_variable_catalog_sort_order_check
    CHECK (sort_order >= 0),
  CONSTRAINT message_variable_catalog_labels_not_blank
    CHECK (btrim(label) <> '')
);

CREATE TRIGGER set_message_variable_catalog_updated_at
  BEFORE UPDATE ON public.message_variable_catalog
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.message_variable_catalog ENABLE ROW LEVEL SECURITY;

-- The catalog is global product metadata: signed-in users may read it, while
-- normal workspace sessions have no INSERT/UPDATE/DELETE table privileges.
REVOKE ALL ON TABLE public.message_variable_catalog FROM anon, authenticated;
GRANT SELECT ON TABLE public.message_variable_catalog TO authenticated;
GRANT ALL ON TABLE public.message_variable_catalog TO service_role;

CREATE POLICY message_variable_catalog_select_authenticated
  ON public.message_variable_catalog
  FOR SELECT
  TO authenticated
  USING (TRUE);

INSERT INTO public.message_variable_catalog (
  variable_key,
  label,
  description,
  category,
  data_type,
  source_scope,
  resolver_key,
  preview_value,
  default_fallback,
  is_sensitive,
  is_active,
  sort_order
)
VALUES
  ('contact.first_name', 'Contact first name', 'First portion derived from the canonical CRM contact name value; the current contact schema has no dedicated first_name column.', 'contact', 'text', 'contact', 'contact.first_name', 'Sandeep', '', FALSE, TRUE, 10),
  ('contact.last_name', 'Contact last name', 'Remaining portion derived from the canonical CRM contact name value; the current contact schema has no dedicated last_name column.', 'contact', 'text', 'contact', 'contact.last_name', 'Sharma', '', FALSE, TRUE, 20),
  ('contact.full_name', 'Contact full name', 'Canonical CRM contact name.', 'contact', 'text', 'contact', 'contact.full_name', 'Sandeep Sharma', '', FALSE, TRUE, 30),
  ('contact.phone', 'Contact phone', 'Canonical CRM contact phone number.', 'contact', 'phone', 'contact', 'contact.phone', '+919876543210', '', TRUE, TRUE, 40),
  ('contact.email', 'Contact email', 'Canonical CRM contact email address.', 'contact', 'email', 'contact', 'contact.email', 'guest@example.com', '', TRUE, TRUE, 50),

  ('reservation.reference', 'Reservation reference', 'Canonical reservation confirmation or reference code.', 'reservation', 'text', 'reservation', 'reservation.reference', 'ABC123', '', FALSE, TRUE, 100),
  ('reservation.status', 'Reservation status', 'Normalized CRM reservation status.', 'reservation', 'text', 'reservation', 'reservation.status', 'confirmed', '', FALSE, TRUE, 110),
  ('reservation.check_in', 'Check-in date', 'Canonical reservation check-in date.', 'reservation', 'date', 'reservation', 'reservation.check_in', '2026-10-15', '', FALSE, TRUE, 120),
  ('reservation.check_out', 'Check-out date', 'Canonical reservation check-out date.', 'reservation', 'date', 'reservation', 'reservation.check_out', '2026-10-18', '', FALSE, TRUE, 130),
  ('reservation.nights', 'Number of nights', 'Nights derived from canonical check-in and check-out dates.', 'reservation', 'number', 'reservation', 'reservation.nights', '3', NULL, FALSE, TRUE, 140),
  ('reservation.guest_count', 'Guest count', 'Canonical total occupancy for the reservation.', 'reservation', 'number', 'reservation', 'reservation.guest_count', '2', NULL, FALSE, TRUE, 150),
  ('reservation.adult_count', 'Adult count', 'Canonical adult guest count.', 'reservation', 'number', 'reservation', 'reservation.adult_count', '2', NULL, FALSE, TRUE, 160),
  ('reservation.child_count', 'Child count', 'Canonical child guest count.', 'reservation', 'number', 'reservation', 'reservation.child_count', '0', NULL, FALSE, TRUE, 170),
  ('reservation.channel', 'Reservation channel', 'Canonical booking channel name or code.', 'reservation', 'text', 'reservation', 'reservation.channel', 'Direct', '', FALSE, TRUE, 180),
  ('reservation.amount', 'Reservation amount', 'Unformatted canonical reservation amount.', 'reservation', 'currency', 'reservation', 'reservation.amount', '12500.00', '', FALSE, TRUE, 190),
  ('reservation.currency', 'Reservation currency', 'ISO currency code associated with the reservation amount.', 'reservation', 'text', 'reservation', 'reservation.currency', 'INR', '', FALSE, TRUE, 200),

  ('property.name', 'Property name', 'Canonical synchronized property name.', 'property', 'text', 'property', 'property.name', 'Lakeside Meadows', '', FALSE, TRUE, 300),
  ('workspace.name', 'Workspace name', 'Active CRM workspace name.', 'workspace', 'text', 'workspace', 'workspace.name', 'Dev ninja', '', FALSE, TRUE, 400)
ON CONFLICT (variable_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  data_type = EXCLUDED.data_type,
  source_scope = EXCLUDED.source_scope,
  resolver_key = EXCLUDED.resolver_key,
  preview_value = EXCLUDED.preview_value,
  default_fallback = EXCLUDED.default_fallback,
  is_sensitive = EXCLUDED.is_sensitive,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  updated_at = timezone('utc', now());

COMMENT ON TABLE public.message_variable_catalog IS
  'Global provider-neutral CRM semantic message variable definitions. Workspace custom fields remain account-scoped and are not copied here.';
