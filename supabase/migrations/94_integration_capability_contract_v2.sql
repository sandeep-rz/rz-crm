-- Integration Capability Contract v2 (CRM).
-- PROPOSED migration only: this file has not been applied to any database.
-- Additive, fail-closed and compatible with active /variables/resolve v1.
BEGIN;

ALTER TABLE public.pms_integrations
  ADD COLUMN IF NOT EXISTS capability_config_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS capability_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS capability_checked_at TIMESTAMPTZ;

ALTER TABLE public.pms_properties
  ADD COLUMN IF NOT EXISTS capability_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS capability_checked_at TIMESTAMPTZ;

ALTER TABLE public.pms_integrations
  ADD CONSTRAINT pms_integrations_capability_config_version_positive
  CHECK (capability_config_version > 0);

-- Capability snapshots are advisory UI metadata only. The trusted executor
-- must revalidate workspace ownership, provider connection and property status.
COMMENT ON COLUMN public.pms_integrations.capability_config_version IS
  'Monotonically increasing invalidation marker for trusted integration context caches. Increment when credentials, connection state or mappings change.';
COMMENT ON COLUMN public.pms_integrations.capability_snapshot IS
  'Provider capability declarations for the UI, not authority for sending/agent actions.';
COMMENT ON COLUMN public.pms_properties.capability_snapshot IS
  'Provider-scoped property eligibility snapshot. Send-time provider checks are authoritative.';

INSERT INTO public.message_variable_catalog (
  variable_key, label, description, category, data_type, source_scope,
  resolution_source, resolver_key, preview_value, default_fallback,
  is_sensitive, is_active, sort_order
) VALUES
  ('reservation.digital_checkin_url','Digital check-in link',
   'Existing reservation-specific guest check-in link when entitled, enabled and valid.',
   'reservation','url','reservation','provider',
   'reservation.digital_checkin_url','https://checkin.example.com/c/example',
   NULL,TRUE,FALSE,230),
  ('reservation.review_destination_url','Review destination',
   'Booking/trips page that may lead to a review; not guaranteed to open the review form.',
   'reservation','url','reservation','provider',
   'reservation.review_destination_url','https://example.com/my-trips',
   NULL,FALSE,FALSE,240),
  ('reservation.review_url','Direct review link',
   'Verified direct guest review entry URL when supported by the provider.',
   'reservation','url','reservation','provider',
   'reservation.review_url','https://example.com/reviews/new',
   NULL,FALSE,FALSE,250)
ON CONFLICT (variable_key) DO NOTHING;

-- These three keys deliberately remain inactive until the PMS v2 API and
-- CRM resolution are deployed, tested, and separately enabled.
COMMIT;
