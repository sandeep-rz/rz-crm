-- Integration Capability Contract v2 (CRM).
-- PROPOSED migration only: this file has not been applied to any database.
-- Additive, fail-closed and compatible with active /variables/resolve v1.
BEGIN;

-- Reuse existing integration/property mappings; no unused capability cache columns.

INSERT INTO public.message_variable_catalog (
  variable_key, label, description, category, data_type, source_scope,
  resolution_source, resolver_key, preview_value, default_fallback,
  is_sensitive, is_active, sort_order
) VALUES
  ('reservation.digital_checkin_url','Digital check-in link',
   'Existing reservation-specific guest check-in link when entitled, enabled and valid.',
   'reservation','url','reservation','provider',
   'reservation.digital_checkin_url','https://checkin.example.com/c/example',
   NULL,TRUE,TRUE,230),
  ('reservation.review_destination_url','Review destination',
   'Booking/trips page that may lead to a review; not guaranteed to open the review form.',
   'reservation','url','reservation','provider',
   'reservation.review_destination_url','https://example.com/my-trips',
   NULL,FALSE,TRUE,240),
  ('reservation.review_url','Direct review link',
   'Verified direct guest review entry URL when supported by the provider.',
   'reservation','url','reservation','provider',
   'reservation.review_url','https://example.com/reviews/new',
   NULL,FALSE,FALSE,250)
ON CONFLICT (variable_key) DO NOTHING;

-- Check-in and destination resolvers ship with this branch; direct review
-- remains unavailable because no verified provider direct-review URL exists.
COMMIT;
