-- RGCRM Canonical Variable Contract v1. Semantic API identifiers only:
-- resolver_key never encodes a provider's internal schema.
BEGIN;

ALTER TABLE public.message_variable_catalog
  DROP CONSTRAINT IF EXISTS message_variable_catalog_category_check,
  DROP CONSTRAINT IF EXISTS message_variable_catalog_source_scope_check,
  DROP CONSTRAINT IF EXISTS message_variable_catalog_data_type_check;
ALTER TABLE public.message_variable_catalog
  ADD CONSTRAINT message_variable_catalog_category_check
    CHECK (category IN ('contact','reservation','property','listing','host','workspace')),
  ADD CONSTRAINT message_variable_catalog_source_scope_check
    CHECK (source_scope IN ('contact','reservation','property','listing','host','workspace')),
  ADD CONSTRAINT message_variable_catalog_data_type_check
    CHECK (data_type IN ('text','phone','email','date','time','number','currency','url')),
  ADD COLUMN IF NOT EXISTS resolution_source TEXT NOT NULL DEFAULT 'context';
ALTER TABLE public.message_variable_catalog
  DROP CONSTRAINT IF EXISTS message_variable_catalog_resolution_source_check;
ALTER TABLE public.message_variable_catalog
  ADD CONSTRAINT message_variable_catalog_resolution_source_check
    CHECK (resolution_source IN ('crm','provider','derived','context'));
COMMENT ON COLUMN public.message_variable_catalog.resolution_source IS
  'Expected resolution strategy, independent of semantic identity. Provider entries are vocabulary only until provider resolution is implemented; context denotes ownership that depends on communication context.';

-- Preserve the old row's ID and created_at when renaming normally. If a target
-- already exists, retain that canonical row and remove only its redundant alias.
DO $$
DECLARE rename RECORD;
BEGIN
  FOR rename IN SELECT * FROM (VALUES
    ('reservation.check_in','reservation.check_in_date'),
    ('reservation.check_out','reservation.check_out_date'),
    ('reservation.amount','reservation.total_amount')
  ) AS keys(old_key,new_key)
  LOOP
    DELETE FROM public.message_variable_catalog AS old
    WHERE old.variable_key=rename.old_key
      AND EXISTS (SELECT 1 FROM public.message_variable_catalog WHERE variable_key=rename.new_key);
    UPDATE public.message_variable_catalog SET variable_key=rename.new_key,
      updated_at=timezone('utc',now()) WHERE variable_key=rename.old_key;
    UPDATE public.message_variable_catalog SET resolver_key=rename.new_key,
      updated_at=timezone('utc',now()) WHERE resolver_key=rename.old_key;
  END LOOP;
END $$;

-- Rewrite only typed semantic mapping identities, never static values, legacy
-- interpolation strings, property names, positional send params, or logs.
-- Session-local helper: no permanent function/RPC is introduced.
CREATE OR REPLACE FUNCTION pg_temp.rgcrm_contract_v1_mapping(value JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE result JSONB;
BEGIN
  IF jsonb_typeof(value)='array' THEN
    SELECT COALESCE(jsonb_agg(pg_temp.rgcrm_contract_v1_mapping(item) ORDER BY ord), '[]'::jsonb)
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item,ord);
    RETURN result;
  ELSIF jsonb_typeof(value)='object' THEN
    SELECT COALESCE(jsonb_object_agg(key, pg_temp.rgcrm_contract_v1_mapping(item)), '{}'::jsonb)
      INTO result FROM jsonb_each(value) AS entries(key,item);
    IF value->>'source_type'='catalog_variable' THEN
      CASE value->>'variable_key'
        WHEN 'reservation.check_in' THEN result=jsonb_set(result,'{variable_key}','"reservation.check_in_date"'::jsonb);
        WHEN 'reservation.check_out' THEN result=jsonb_set(result,'{variable_key}','"reservation.check_out_date"'::jsonb);
        WHEN 'reservation.amount' THEN result=jsonb_set(result,'{variable_key}','"reservation.total_amount"'::jsonb);
        ELSE NULL;
      END CASE;
    END IF;
    RETURN result;
  END IF;
  RETURN value;
END $$;

DO $$ BEGIN
  IF to_regclass('public.automation_steps') IS NOT NULL THEN
    UPDATE public.automation_steps
      SET step_config=pg_temp.rgcrm_contract_v1_mapping(step_config)
      WHERE step_config IS DISTINCT FROM pg_temp.rgcrm_contract_v1_mapping(step_config);
  END IF;
  IF to_regclass('public.broadcasts') IS NOT NULL THEN
    UPDATE public.broadcasts
      SET template_variables=pg_temp.rgcrm_contract_v1_mapping(template_variables)
      WHERE template_variables IS DISTINCT FROM pg_temp.rgcrm_contract_v1_mapping(template_variables);
  END IF;
END $$;
DROP FUNCTION pg_temp.rgcrm_contract_v1_mapping(JSONB);

INSERT INTO public.message_variable_catalog (
 variable_key,label,description,category,data_type,source_scope,resolver_key,
 preview_value,default_fallback,is_sensitive,is_active,sort_order,resolution_source
) VALUES
  ('contact.first_name', 'Contact first name', 'Contact first name of the person associated with the communication.', 'contact', 'text', 'contact', 'contact.first_name', 'Sandeep', NULL, FALSE, TRUE, 10, 'context'),
  ('contact.last_name', 'Contact last name', 'Contact last name of the person associated with the communication.', 'contact', 'text', 'contact', 'contact.last_name', 'Sharma', NULL, FALSE, TRUE, 20, 'context'),
  ('contact.full_name', 'Contact full name', 'Contact full name of the person associated with the communication.', 'contact', 'text', 'contact', 'contact.full_name', 'Sandeep Sharma', NULL, FALSE, TRUE, 30, 'context'),
  ('contact.phone', 'Contact phone', 'Contact phone of the person associated with the communication.', 'contact', 'phone', 'contact', 'contact.phone', '+919876543210', NULL, TRUE, TRUE, 40, 'context'),
  ('contact.email', 'Contact email', 'Contact email of the person associated with the communication.', 'contact', 'email', 'contact', 'contact.email', 'guest@example.com', NULL, TRUE, TRUE, 50, 'context'),
  ('reservation.reference', 'Reservation reference', 'Reservation reference associated with the communication context.', 'reservation', 'text', 'reservation', 'reservation.reference', 'RZ12345', NULL, FALSE, TRUE, 100, 'context'),
  ('reservation.status', 'Reservation status', 'Reservation status associated with the communication context.', 'reservation', 'text', 'reservation', 'reservation.status', 'confirmed', NULL, FALSE, TRUE, 110, 'context'),
  ('reservation.check_in_date', 'Check-in date', 'Check-in date associated with the communication context.', 'reservation', 'date', 'reservation', 'reservation.check_in_date', '2026-10-15', NULL, FALSE, TRUE, 120, 'context'),
  ('reservation.check_out_date', 'Check-out date', 'Check-out date associated with the communication context.', 'reservation', 'date', 'reservation', 'reservation.check_out_date', '2026-10-18', NULL, FALSE, TRUE, 130, 'context'),
  ('reservation.nights', 'Number of nights', 'Number of nights associated with the communication context.', 'reservation', 'number', 'reservation', 'reservation.nights', '3', NULL, FALSE, TRUE, 140, 'derived'),
  ('reservation.guest_count', 'Guest count', 'Guest count associated with the communication context.', 'reservation', 'number', 'reservation', 'reservation.guest_count', '2', NULL, FALSE, TRUE, 150, 'context'),
  ('reservation.adult_count', 'Adult count', 'Adult count associated with the communication context.', 'reservation', 'number', 'reservation', 'reservation.adult_count', '2', NULL, FALSE, TRUE, 160, 'context'),
  ('reservation.child_count', 'Child count', 'Child count associated with the communication context.', 'reservation', 'number', 'reservation', 'reservation.child_count', '0', NULL, FALSE, TRUE, 170, 'context'),
  ('reservation.channel', 'Reservation channel', 'Reservation channel associated with the communication context.', 'reservation', 'text', 'reservation', 'reservation.channel', 'Direct', NULL, FALSE, TRUE, 180, 'context'),
  ('reservation.average_nightly_price', 'Average nightly price', 'Average nightly price associated with the communication context.', 'reservation', 'currency', 'reservation', 'reservation.average_nightly_price', '4000.00', NULL, FALSE, TRUE, 190, 'provider'),
  ('reservation.total_amount', 'Total reservation amount', 'Total reservation amount associated with the communication context.', 'reservation', 'currency', 'reservation', 'reservation.total_amount', '12500.00', NULL, FALSE, TRUE, 200, 'context'),
  ('reservation.cleaning_fee', 'Cleaning fee', 'Cleaning fee associated with the communication context.', 'reservation', 'currency', 'reservation', 'reservation.cleaning_fee', '500.00', NULL, FALSE, TRUE, 210, 'provider'),
  ('reservation.currency', 'Reservation currency', 'Reservation currency associated with the communication context.', 'reservation', 'text', 'reservation', 'reservation.currency', 'INR', NULL, FALSE, TRUE, 220, 'context'),
  ('property.name', 'Property name', 'Property name associated with the communication context.', 'property', 'text', 'property', 'property.name', 'Lakeside Meadows', NULL, FALSE, TRUE, 300, 'context'),
  ('property.city', 'Property city', 'Property city associated with the communication context.', 'property', 'text', 'property', 'property.city', 'Gurugram', NULL, FALSE, TRUE, 310, 'provider'),
  ('property.address', 'Property address', 'Property address associated with the communication context.', 'property', 'text', 'property', 'property.address', 'Sector 30, Gurugram, Haryana', NULL, TRUE, TRUE, 320, 'provider'),
  ('property.wifi_details', 'Wi-Fi details', 'Wi-Fi details associated with the communication context.', 'property', 'text', 'property', 'property.wifi_details', 'Wi-Fi: RZ Stay WiFi / Password: ********', NULL, TRUE, TRUE, 330, 'provider'),
  ('property.staff_details', 'Staff / caretaker details', 'Staff / caretaker details associated with the communication context.', 'property', 'text', 'property', 'property.staff_details', 'Staff: Ramesh / Phone: +919999999999', NULL, TRUE, TRUE, 340, 'provider'),
  ('property.check_in_method', 'Check-in method', 'Check-in method associated with the communication context.', 'property', 'text', 'property', 'property.check_in_method', 'Self check-in', NULL, FALSE, TRUE, 350, 'provider'),
  ('property.directions', 'Directions', 'Directions associated with the communication context.', 'property', 'text', 'property', 'property.directions', 'Use the map link and call the host if needed.', NULL, FALSE, TRUE, 360, 'provider'),
  ('property.getting_around', 'Getting around', 'Getting around associated with the communication context.', 'property', 'text', 'property', 'property.getting_around', 'Cabs and autos are easily available nearby.', NULL, FALSE, TRUE, 370, 'provider'),
  ('property.checkout_instructions', 'Checkout instructions', 'Checkout instructions associated with the communication context.', 'property', 'text', 'property', 'property.checkout_instructions', 'Please switch off appliances and return keys before checkout.', NULL, FALSE, TRUE, 380, 'provider'),
  ('property.house_manual', 'House manual', 'House manual associated with the communication context.', 'property', 'text', 'property', 'property.house_manual', 'Please switch off appliances before leaving.', NULL, FALSE, TRUE, 390, 'provider'),
  ('listing.name', 'Listing name', 'Listing name associated with the communication context.', 'listing', 'text', 'listing', 'listing.name', 'Luxury 1BHK near Cyber Hub', NULL, FALSE, TRUE, 500, 'provider'),
  ('listing.check_in_time', 'Check-in time', 'Standard arrival time for the booked listing/unit; distinct from the reservation check-in date.', 'listing', 'time', 'listing', 'listing.check_in_time', '14:00', NULL, FALSE, TRUE, 510, 'provider'),
  ('listing.check_out_time', 'Check-out time', 'Standard departure time for the booked listing/unit; distinct from the reservation check-out date.', 'listing', 'time', 'listing', 'listing.check_out_time', '11:00', NULL, FALSE, TRUE, 520, 'provider'),
  ('listing.bedroom_count', 'Number of bedrooms', 'Number of bedrooms associated with the communication context.', 'listing', 'number', 'listing', 'listing.bedroom_count', '1', NULL, FALSE, TRUE, 530, 'provider'),
  ('listing.bathroom_count', 'Number of bathrooms', 'Number of bathrooms associated with the communication context.', 'listing', 'number', 'listing', 'listing.bathroom_count', '1', NULL, FALSE, TRUE, 540, 'provider'),
  ('listing.house_rules', 'House rules', 'House rules associated with the communication context.', 'listing', 'text', 'listing', 'listing.house_rules', 'No smoking. No parties.', NULL, FALSE, TRUE, 550, 'provider'),
  ('listing.guest_access', 'Guest access', 'Guest access associated with the communication context.', 'listing', 'text', 'listing', 'listing.guest_access', 'Entire apartment access.', NULL, FALSE, TRUE, 560, 'provider'),
  ('host.full_name', 'Primary host full name', 'Primary host full name of the primary property/listing host associated with the reservation.', 'host', 'text', 'host', 'host.full_name', 'Safiya Akhtar', NULL, FALSE, TRUE, 600, 'provider'),
  ('host.phone', 'Primary host phone', 'Primary host phone of the primary property/listing host associated with the reservation.', 'host', 'phone', 'host', 'host.phone', '+919999999999', NULL, TRUE, TRUE, 610, 'provider'),
  ('workspace.name', 'Workspace name', 'Name of the CRM workspace associated with the communication.', 'workspace', 'text', 'workspace', 'workspace.name', 'Dev ninja', NULL, FALSE, TRUE, 700, 'crm')
ON CONFLICT (variable_key) DO UPDATE SET
 label=EXCLUDED.label, description=EXCLUDED.description, category=EXCLUDED.category,
 data_type=EXCLUDED.data_type, source_scope=EXCLUDED.source_scope,
 resolver_key=EXCLUDED.resolver_key, preview_value=EXCLUDED.preview_value,
 is_sensitive=EXCLUDED.is_sensitive, is_active=EXCLUDED.is_active,
 sort_order=EXCLUDED.sort_order, resolution_source=EXCLUDED.resolution_source,
 updated_at=timezone('utc',now());
-- Existing fallback configuration and created_at are deliberately preserved.
COMMENT ON TABLE public.message_variable_catalog IS
 'RGCRM Canonical Variable Contract v1. Stable semantic API identifiers independent of provider schemas; adding keys is compatible, renaming/removing/repurposing keys requires migration.';
COMMIT;
