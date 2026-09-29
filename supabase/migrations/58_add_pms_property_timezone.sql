-- Property-local wall-clock scheduling for PMS automations.
--
-- The value is nullable so existing integrations continue working while the
-- upstream PMS starts supplying a timezone. Scheduled automations without a
-- legacy automation-level timezone are rejected at activation until every
-- property they target has one.

ALTER TABLE public.pms_properties
  ADD COLUMN timezone TEXT;

ALTER TABLE public.pms_properties
  ADD CONSTRAINT pms_properties_timezone_not_blank
  CHECK (timezone IS NULL OR btrim(timezone) <> '');

COMMENT ON COLUMN public.pms_properties.timezone IS
  'IANA timezone supplied by the PMS for property-local automation scheduling.';
