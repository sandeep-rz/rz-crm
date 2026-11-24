# Integration Capability Contract v2 — foundation and RZ-PMS review

Status: **proposed / additive only**. The TypeScript capability contract is implemented; no production endpoints, migrations, provider API changes, agent actions or automations have been enabled. Existing `v1` variable resolution is unchanged.

## Confirmed RZ-PMS behavior (read-only Supabase review, 2026-11-24)

Projects inspected: `rz-pms` (production) and `rz-pms-dev`. The following function and table detail is from **production**.

### Digital check-in

- Property control: `property_checkin_settings.is_enabled`, gated by `has_digital_checkin_property_entitlement(property_id)`.
- `ensure_guest_checkin_session_for_booking(p_booking_id, p_pms_booking_id)` checks exactly one reservation ID, loads its property and host, checks entitlement + enabled flag, rejects ineligible statuses, then creates or reuses a session with advisory locking.
- Session rows: `guest_checkin_sessions`; guest-specific access: `guest_checkin_guest_access`. Session links use a bearer token; the base URL currently comes from `get_guest_checkin_base_url` (`https://checkin.rukiyezara.com/c/`).
- The function **creates/modifies state**, including access tokens and expiry. Do **not** call this function from a read-only variable resolver, browser or LLM. An authenticated, idempotent PMS-side integration API should use it deliberately when creating or ensuring the link, then expose a read-only lookup of link eligibility/status.
- Property link send mode exists (`manual` among observed values); CRM must not assume PMS sends the link automatically.
- The proposed link is a bearer credential. Do not log its value, expose it in broad telemetry or place it in model context unless needed to answer the authenticated guest. Validate recipient/reservation linkage and eligibility at send time.

### Review URLs and reminders

- `resolve_whatsapp_review_url(source_type, source_record_id)` maps channels to *trip/booking pages*: RZ `/my-bookings`, Airbnb `/trips`, Booking.com `/mytrips.html`, Agoda `/trips`, MakeMyTrip `/myTrips/`. These are **not proven direct review-entry links**.
- `get_whatsapp_booking_context` exposes a `review.link` based on that resolver. Do not present it as a guaranteed one-click review URL.
- `review_popup` tracks guest/host review state; `reviews` and `ota_reviews` are distinct review sources.
- `notification_event_types` registers `review.guest_reminder`, `review.host_reminder`, `review.guest_submitted`, `review.host_submitted` and other review events. Those entries currently have `supports_whatsapp=false` (notification layer).
- PMS also has property WhatsApp campaign rules, scheduled runs and a `resolve_whatsapp_campaign_variables` function. The review URL is in the PMS automation context. However, no active provider accounts or automation rules were observed in the reviewed production tables; this **does not prove** delivery behavior through AiSensy.
- `whatsapp_providers` marks `aisensy` active and other providers inactive. That is a **PMS outbound messaging provider**, distinct from the **PMS data integration provider** in CRM. Do not confuse these two registries.

### Integration identities

- CRM already stores `pms_integrations` (provider, external account), `pms_properties` (provider property mapping) and `pms_reservations` (provider reservation mapping).
- CRM currently registers only `rukiye_zara` in `src/lib/integrations/pms/variable-registry.ts`.
- CRM's current `/v1/integrations/rz-crm/variables/resolve` adapter returns `resolved | missing | unsupported`; changing its response shape requires explicit contract negotiation, not a silent v1 change.
- Host IDs and group IDs are provider-specific; trusted adapter configuration should store them or derive them from a securely persisted external-account identity. They must never be supplied by the AI model.

## v2 contract boundaries

1. **Capability declaration**: `supported | unsupported | unknown` at integration level. Unknown does not mean supported.
2. **Property eligibility**: checked against the provider's property state/entitlements; cacheable only with versioning/invalidation.
3. **Reservation outcome**: `resolved` URL or missing/unsupported plus safe reason code. Feature enabled does not guarantee a link is ready.
4. **Tool routing**: server-created tenant/integration/property identity scope. A model may request dates and guest counts; a trusted executor sets external account/group/property IDs.
5. **Operations**: `variable` (read), `query` (live data), `action` (side effects), `event` (observed fact). Action tools require authorization and idempotency; pricing/availability must be requested live.
6. **Compatibility**: existing approved templates and `contract_version:v1` untouched. Only expose new catalog keys after corresponding provider APIs and tests work.

## Implementation sequence (remaining)

**PMS-side**:
1. Add a **read-only**, authenticated integration endpoint for digital check-in eligibility and current link, scoped to integration and reservation ownership; keep link creation idempotent and explicit. Confirm with product whether link may be created at booking confirmation or only near check-in, and whether CRM sending is permitted when `link_send_mode=manual`.
2. Add provider capability discovery (integration and property) with freshness/version markers.
3. Define separate `reservation.review_destination_url` (generic trip page) and `reservation.review_url` (verified direct review link), with channel-specific support and eligibility, and expose review-submitted status/events.
4. Use an outbox/idempotency key for review event delivery; deduplicate retries.

**CRM-side**:
1. Add catalog entry `reservation.digital_checkin_url` and provider-side resolver support together, only after PMS endpoint exists. Do **not** insert a new catalog row before the provider resolves it.
2. Extend `ConnectedVariableValue` with optional reasons via an explicitly negotiated v2 response. Keep v1 intact.
3. Add integration/property capability snapshots and server-side authorization to the runtime cache. Version and invalidate snapshots on disconnect/relink/permissions changes.
4. Add automation condition `capability available` and use distinct approved Meta templates for link/no-link branches. A failed dynamic variable must not silently render an empty URL.
5. Add read-only URL availability preview in CRM; never let preview create guest tokens.
6. Implement review reminder after checkout using CRM's scheduled-reservation machinery; suppress for cancellation, invalid link or review already submitted; support opt-out and idempotent sending.
7. Future agent tool executor uses trusted binding, not raw API endpoints in prompts.

## Distinguish two registries

- **Data provider**: e.g. RZ-PMS, future third-party PMS; responsible for reservations, check-in, reviews and availability.
- **Messaging provider**: e.g. Meta Cloud API in CRM or AiSensy in PMS; responsible for delivering WhatsApp messages. Ownership of automation/sending should be explicit to prevent duplicate reminders.

## Security and quality acceptance

- No cross-tenant/property lookup; disabled property fails closed.
- No provider credentials or bearer check-in links in logs, error diagnostics or model prompt traces.
- No link-creating side effect from capability discovery/preview.
- Reject non-HTTPS and credential-bearing URLs.
- Correct behavior for revoked/expired session links and cancelled reservations.
- Retryable provider errors distinguished from permanent unsupported/feature-disabled conditions.
- Revalidate connection/version/permissions at execution time even if config is cached.
- Add integration tests for PMS eligibility, token lifecycle and review-channel URL semantics before production enablement.
