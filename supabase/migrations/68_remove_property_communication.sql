-- Remove the retired CRM-owned hospitality data model. Dropping the table
-- also removes its policies, grants, timestamp trigger, indexes and outbound
-- foreign keys. RESTRICT deliberately refuses unexpected shared dependencies.
-- Keep pms_properties and the shared update_updated_at_column function.
BEGIN;

DROP TABLE IF EXISTS public.property_communication_settings RESTRICT;

-- Existing template/automation JSON mappings are retained. Retired keys become
-- unknown catalog variables and follow existing validation instead of sending
-- obsolete hospitality values. Preserve property.name and all other variables.
DO $$
BEGIN
  IF to_regclass('public.message_variable_catalog') IS NOT NULL THEN
    DELETE FROM public.message_variable_catalog
    WHERE variable_key IN (
      'property.map_url',
      'property.checkin_method',
      'property.directions',
      'property.parking_instructions',
      'property.nearby_landmark',
      'property.caretaker_name',
      'property.caretaker_phone',
      'property.emergency_phone',
      'property.wifi_name',
      'property.wifi_password',
      'property.house_manual',
      'property.checkout_instructions'
    );
  END IF;
END
$$;

COMMIT;
