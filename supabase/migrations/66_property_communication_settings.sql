-- CRM-owned, provider-neutral guest communication details for canonical
-- properties. PMS systems may prefill this record during a future initial
-- provisioning flow, but CRM owns every value after the row is created.

CREATE TABLE public.property_communication_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  pms_property_id UUID NOT NULL,

  map_url TEXT,
  checkin_method TEXT,
  directions TEXT,
  parking_instructions TEXT,
  nearby_landmark TEXT,

  caretaker_name TEXT,
  caretaker_phone TEXT,
  emergency_phone TEXT,

  wifi_name TEXT,
  wifi_password TEXT,

  house_manual TEXT,
  checkout_instructions TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT property_communication_settings_account_property_unique
    UNIQUE (account_id, pms_property_id),
  CONSTRAINT property_communication_settings_property_account_fkey
    FOREIGN KEY (pms_property_id, account_id)
    REFERENCES public.pms_properties(id, account_id)
    ON DELETE CASCADE
);

CREATE TRIGGER set_property_communication_settings_updated_at
  BEFORE UPDATE ON public.property_communication_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.property_communication_settings IS
  'CRM-owned guest communication settings for one canonical PMS property. These values are not reconciled back to or continuously synchronized from a PMS.';

ALTER TABLE public.property_communication_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.property_communication_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.property_communication_settings TO authenticated;
GRANT ALL ON TABLE public.property_communication_settings TO service_role;

CREATE POLICY property_communication_settings_select
  ON public.property_communication_settings
  FOR SELECT
  TO authenticated
  USING (public.is_account_member(account_id));

CREATE POLICY property_communication_settings_insert
  ON public.property_communication_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_account_member(account_id, 'admin')
    AND EXISTS (
      SELECT 1
      FROM public.pms_properties AS property
      WHERE property.id = pms_property_id
        AND property.account_id = property_communication_settings.account_id
    )
  );

CREATE POLICY property_communication_settings_update
  ON public.property_communication_settings
  FOR UPDATE
  TO authenticated
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (
    public.is_account_member(account_id, 'admin')
    AND EXISTS (
      SELECT 1
      FROM public.pms_properties AS property
      WHERE property.id = pms_property_id
        AND property.account_id = property_communication_settings.account_id
    )
  );

CREATE POLICY property_communication_settings_delete
  ON public.property_communication_settings
  FOR DELETE
  TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

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
  ('property.map_url', 'Property map URL', 'CRM-owned exact map location for the property.', 'property', 'url', 'property', 'property.map_url', 'https://maps.google.com/?q=12.9716,77.5946', NULL, TRUE, TRUE, 310),
  ('property.checkin_method', 'Check-in method', 'CRM-owned guest check-in method for the property.', 'property', 'text', 'property', 'property.checkin_method', 'Self check-in with lockbox', NULL, TRUE, TRUE, 320),
  ('property.directions', 'Directions', 'CRM-owned arrival directions for the property.', 'property', 'text', 'property', 'property.directions', 'Follow the lake road to the blue gate.', NULL, TRUE, TRUE, 330),
  ('property.parking_instructions', 'Parking instructions', 'CRM-owned guest parking instructions for the property.', 'property', 'text', 'property', 'property.parking_instructions', 'Use the marked space beside the entrance.', NULL, TRUE, TRUE, 340),
  ('property.nearby_landmark', 'Nearby landmark', 'CRM-owned nearby landmark used to help guests locate the property.', 'property', 'text', 'property', 'property.nearby_landmark', 'Opposite Lakeside Café', NULL, TRUE, TRUE, 350),
  ('property.caretaker_name', 'Caretaker name', 'CRM-owned caretaker contact name for the property.', 'property', 'text', 'property', 'property.caretaker_name', 'Anil', NULL, FALSE, TRUE, 360),
  ('property.caretaker_phone', 'Caretaker phone', 'CRM-owned caretaker phone number for the property.', 'property', 'phone', 'property', 'property.caretaker_phone', '+919876543210', NULL, TRUE, TRUE, 370),
  ('property.emergency_phone', 'Emergency phone', 'CRM-owned emergency contact number for the property.', 'property', 'phone', 'property', 'property.emergency_phone', '+919876543211', NULL, TRUE, TRUE, 380),
  ('property.wifi_name', 'Wi-Fi name', 'CRM-owned Wi-Fi network name for the property.', 'property', 'text', 'property', 'property.wifi_name', 'LakesideGuest', NULL, FALSE, TRUE, 390),
  ('property.wifi_password', 'Wi-Fi password', 'CRM-owned Wi-Fi password for the property.', 'property', 'text', 'property', 'property.wifi_password', '••••••••', NULL, TRUE, TRUE, 400),
  ('property.house_manual', 'House manual', 'CRM-owned guest house manual or house instructions for the property.', 'property', 'text', 'property', 'property.house_manual', 'Please review the house guide before arrival.', NULL, TRUE, TRUE, 410),
  ('property.checkout_instructions', 'Checkout instructions', 'CRM-owned checkout instructions for the property.', 'property', 'text', 'property', 'property.checkout_instructions', 'Return the key and switch off the lights.', NULL, FALSE, TRUE, 420)
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
