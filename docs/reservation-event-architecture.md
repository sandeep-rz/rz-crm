# Shared reservation domain events — 27 November 2026

The unapplied PMS migration has been simplified in place. It creates **one** new PMS table instead of three. No new bus/outbox/delivery system was added. The paired CRM migrations require no changes because the existing HTTP contracts, parent IDs and decimal-string source versions remain compatible.

| Before | After | Reason |
| --- | --- | --- |
| `crm_reservation_event_state` | `reservation_event_state` | Shared parent/native lifecycle, monotonic version and SHA-256 hash; no full snapshot persisted. |
| `crm_native_confirmation_state` | Same shared table | Native confirmation marker survives domain-event archival. |
| `crm_reservation_event_operations` | Removed | Existing source revision/request deduplication plus locked hash comparison covers actual production callers; there was no independent external-operation caller to retain. |

Zero new tables was rejected: `domain_events` does not provide a permanent lifecycle or version-retention contract. Rebuilding confirmation/version state from an archived outbox would permit re-confirmation or version reset. No event metadata has been moved onto business rows.

## Production execution

Existing deferred booking, guest/profile, parent, financial-ledger, partial-payment and adjustment paths call `emit_reservation_event(source_type, source_record_id, historical)`. The function locks the actual `bookings` row or `pms_reservations` parent before reading final state. Both sources then share the same classifier, hash comparison, durable confirmation latch, version allocation and existing `emit_domain_event()` call. State and outbox commit or roll back together.

The shared primary key is `(source_type, source_record_id)`. Generated source-specific foreign keys enforce existence in the correct business table; a validation trigger verifies the source/property relationship and immutable event identity. RLS is enabled. New table access and callable helper/RPC permissions are service-only; browser/auth architecture is unchanged. Definer gateways retain the Security Rulebook's fixed search_path. The table stores no guest fields or financial payloads.

Hash input covers room IDs/listings/status/dates/assignment/rates, categorized occupancy, effective guest identity/profile and explicit clears, paid/balance/status, refunds, payment records, partial payments and adjustments. JSONB object keys and numeric scale are normalized; set-like arrays and room/ledger records have deterministic ordering. Adult/child/infant/pet counts use named keys, so exchanging categories does not collapse to the same hash. Timestamps used only for bookkeeping do not change the digest. Guest and raw payment details remain transient hash inputs and are excluded from the outward event payload. The CRM view continues reading authoritative tables with the shared source version, not a persisted snapshot.

An unchanged digest returns without touching version/state or enqueuing another event. A changed digest increments the persisted version: A → B → A across committed operations produces two distinct updates. Repeated deferred callbacks see the same final digest and converge. Transaction IDs remain available on existing domain events for correlation; they are not used as cross-transaction replay protection.

## Durable replay and confirmation guarantees

Live MCP inspection on 27 November confirmed:

- `commit_pms_booking_inventory_delta` takes booking advisory/row locks and checks `pms_booking_revisions(booking_id, revision_id)` before writes. Complete replay returns success without writes; mixed stale/partial revisions raise `40001`. Channex callers pass `channex:{revisionId}` and persist all rooms in that RPC.
- Walk-in creation also writes all rooms through that RPC. Replaying the same persisted booking/revision IDs is rejected there. A brand-new HTTP create request generates new booking IDs and is a new business operation, as before; event infrastructure cannot infer equivalence between independently created reservations.
- Grouped payment/cancellation/modification workflows keep their existing request-ID records and transactional boundaries. No source-side replay record is removed by this refactor.
- The installed daily `rz-operational-data-cleanup-daily` calls `cleanup_old_operational_data(30)`. Its live definition deletes notification events, availability records, processed Open Channel requests and PMS action audit rows. It does not delete domain events or PMS booking revisions. No domain-event deletion function was found in the inspected public/private function bodies. Nevertheless permanent outbox retention is not assumed: the shared confirmation marker and source version survive pruning.

Silent baseline initializes both source kinds while writers are locked. Existing confirmed/cancelled native reservations cannot replay confirmation after cancellation/reinstatement, even if prior domain events disappear. Native `confirmed_at` and available old confirmation-key evidence also protect historical pending records known to have been confirmed. A genuinely pending reservation without prior confirmation emits its first confirmation when it becomes confirmed. The native first-confirmation key remains `reservation:rz:{booking_id}:confirmed`; later events use the durable source version. Parent event keys retain their existing versioned format.

The operation ledger is unnecessary for these callers: duplicate incoming operations are stopped by their existing business revision/request identity, and unchanged state is stopped by the shared hash. Directly writing an old value with no source revision/request ID is indistinguishable from an intentional reversion; neither transaction IDs nor the former transaction-key ledger can solve that ambiguity. Trusted writers must continue using the existing mutation RPCs for replayable source operations. Deferred constraints must not be forced early in the middle of a multi-room operation.

## Migration order and rollback

The migrations remain unapplied; apply only under the existing backup/pause/drain procedure:

1. CRM `94_integration_capability_contract_v2.sql` (after existing 93).
2. CRM `20261126180830_canonical_reservation_integration.sql`.
3. PMS `apps/rz-api/supabase/migrations/20261126180710_crm_canonical_reservation_integration.sql` (edited in place).
4. Release the paired code, complete every active property's full canonical reconciliation while sends are paused, then validate and resume workers.

Do not blindly replay older PMS migrations: live schema/history drift documented in the completion report remains relevant. CRM projection/version enforcement, retained historical child IDs/contacts/job history, atomic webhook completion, identity checks, paging/watermarks, master check-in and review destinations are unchanged.

The PMS rollback script now removes the renamed domain trigger attachments and restores the captured original functions. Keep `reservation_event_state` and existing outbox data; do not reset hashes, versions or confirmation markers, and do not re-baseline it during an application rollback. A later restoration of the new producer resumes from that retained state. CRM rollback instructions remain unchanged; old workers must stay paused until they can handle persisted canonical IDs.

## Files and validation

PMS changes: staged integration migration; read-only CRM context contract; shared event-state regression SQL; rollback script; completion report; this architecture report. CRM changes: completion report, matching architecture report and v2 contract notes. CRM SQL migrations and TypeScript response types need no edits.

Static TypeScript, scoped lint, SQL parsing and PL/pgSQL parsing are checked; runtime tests are operator-owned. PL/pgSQL parsing represents catalog row types as records and does not validate database execution. Run `supabase/tests/reservation_event_state.sql` after the staged migration in an approved test database for normalization, both producers, A → B → A, unchanged state and callback convergence. The script also lists the isolated-clone lifecycle/pruning/concurrency scenarios that need their normal business mutation fixtures. It uses a rollback-only transaction and must not be run against production without reviewing its fixture assumptions.

No known remaining development blocker. Actual migration rehearsal, concurrent-provider/runtime tests and the previously documented schema-history drift remain release gates. No migration, database write, deployment, merge or production-record deletion was performed during development.

## Static validation result and changed-file manifest

Both `rz-api` and CRM `tsc --noEmit --incremental false` passed. Scoped API/provider/scheduler/worker ESLint passed with zero errors or warnings. The staged PMS migration, both unchanged CRM migrations, rollback SQL and both PMS contract/regression scripts passed SQL and PL/pgSQL parsing (catalog row types represented as records). Runtime/database tests were not executed.

PMS files:

- `apps/rz-api/supabase/migrations/20261126180710_crm_canonical_reservation_integration.sql`
- `supabase/tests/crm_reservation_context_contract.sql`
- `supabase/tests/reservation_event_state.sql`
- `docs/sql/crm_integration_rollback.sql`
- `docs/crm-reservation-integration.md`
- `docs/reservation-event-architecture.md`

CRM files:

- `docs/canonical-reservation-completion.md`
- `docs/reservation-event-architecture.md`
- `integrations/rz-pms/API_CONTRACT_V2.md`
