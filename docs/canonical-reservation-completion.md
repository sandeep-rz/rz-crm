# Canonical reservation integration — development completion, 26 November 2026

Implemented on PMS `feat/crm-reservation-integration` and CRM `feature/integration-capabilities-v2-20261124`. No migration was applied; no deployment, push, PR merge, database mutation, or message send was performed. Runtime tests are reserved for the operator. This report supersedes the draft rollout instructions.

## Owning schemas and review evidence

Live catalog/function/trigger/constraint reads used Supabase MCP against PMS production `suanogblzivcqhrysshz`, PMS DEV `vcxwyghdcgofljgpwgbj`, and CRM `ideibnrtszjdrxsusnwc`. The July dump was not used. Production PMS had 2,642 child rows in the three supported states (`new`, `modified`, `cancelled`); DEV had `new` and `cancelled`. Parent identity, guest context, native financial fields, check-in token columns, CRM job leases, unique keys and scheduler RPC contracts were inspected live.

PMS migration history does **not** describe all current objects: its latest registered production migration was `20261121164422`, while parent/check-in objects already exist. DEV's latest registered migration was `20261121164359`. CRM history ends at 93. Do not blindly replay old PMS migrations against an already modified schema. Inspect the owning live objects and reconcile migration history separately before using a blanket CLI push.

The original Security Rulebook supplied in this chat governs these changes. New RPCs are Class E: trusted integration API/workers only, explicit revokes from PUBLIC/anon/authenticated and service_role grants; invoker by default. Definer trigger gateways and the bounded watermark RPC use `SET search_path TO 'public', 'pg_temp'`. New tables have RLS and service-only grants. The internal view uses security_invoker. Existing credential verification, host/team/session architecture, webhook authentication and tenant/property entitlement checks remain in their existing owners. No feature flags were introduced.

## Completed production paths

| Area | Final behavior |
| --- | --- |
| Parent lifecycle producer | Existing deferred PMS booking trigger calls the versioned producer. A parent lock, operation identity, state/version and existing outbox write form one transaction. Multi-room writes use the existing `commit_pms_booking_inventory_delta` RPC; no per-room HTTP emitter was added. Silent baseline prevents historical confirmation replay. |
| Payments and guests | Booking writes, guest linkage/profile changes, parent changes, transaction/refund ledger writes, partial-payment records and native/PMS adjustment writes reach deferred producers. Payment amount, balance, history/refund and guest-only changes participate in snapshots. Native transaction identity replaces state-hash deduplication, permitting legitimate state reversions. Substantive writes advance source timestamps even when callers omit updated_at. |
| Read consistency | Parent room guests and financial values are read with their source version in one database statement. The former follow-up guest query could mix two committed versions and has been removed. Unknown financial components remain null. Multiple listings never receive an invented single-listing identity. |
| Projection | The actual reservation sync uses a service-only atomic projection/version RPC. Older/equal source versions cannot overwrite a newer row. Versions travel as decimal strings and are bounded to PostgreSQL bigint. |
| Historical children | Authenticated PMS aliases select an existing parent row, otherwise the oldest historical row, with UUID as tie-breaker. Every internal reservation ID and contact survives. Other room rows gain a canonical pointer. Original reservations and jobs are captured in service-only reconciliation history before changes. Pending duplicate room jobs are cancelled in place; jobs/logs remain linked to their original rows. No contact records are merged. |
| Projection recovery | A pending-identity data marker holds jobs between reconciliation and projection. It is cleared only by successful projection. It is migration state, not a rollout/feature switch. |
| Event completion | Existing scheduler builds the plan; one RPC commits jobs, timing cancellation and webhook completion under the current lease. It verifies source version, projection timestamp, property timezone and automation configuration. Timing upserts are submitted one automation at a time, matching the live RPC interface. Projection success alone never marks an event complete. |
| Historical occurrences | Confirmation and completed/in-flight timing evidence is checked across canonical and retained child rows. Existing completed or processing jobs are not reopened by schedule upsert. Historical unversioned parent/child envelopes refresh projections but do not replay lifecycle events. |
| Initial/periodic sync | Both workers use canonical pages and repair future timing jobs without creating historical confirmation/update/cancellation occurrences. Cursor loops are rejected; all pages and mapped-guest recovery must succeed before checkpointing. |
| Watermark | Each page supplies a source-database watermark pinned behind open PMS transactions. CRM stores the conservative minimum only after complete success, rounding down to milliseconds. Inclusive filtering and microsecond cursor precision are retained. A long idle transaction intentionally pins progress rather than losing its later commit. Old end-of-run watermarks are preserved in metadata and reset once for a silent full reconciliation. |
| Existing automations | Claims hold unresolved identities without consuming attempts. Workers, SQL execution gate, resumed waits and each contact-dependent action recheck current identity. Retained aliases cannot send. Queued cancellation/confirmation jobs cannot send after lifecycle changes; versioned event jobs also validate source version at dispatch. Unknown legacy PMS wait origin fails closed. |
| Variables/check-in | Existing v1 approved-template response shape is preserved. Parent requests use aggregate parent booking/guest data and a read-only master check-in link; they do not resolve a parent as a child. Multi-listing details and unknown financial components remain missing. v2 URLs retain tenant echo and HTTPS validation. |

## Review corrections

Fixed an undefined `V2_LINK_VARIABLES`, bigint literals incompatible with CRM's TypeScript target, webhook-claim inference errors, a misplaced Supabase filter, stale watermark advancement, multiple-automation schedule batching, mixed-version guest enrichment, unversioned fallback scheduling, stale queued lifecycle jobs, and gaps in resumed-wait identity checks. Consolidated every canonical SQL draft and moved PMS capability SQL out of the CRM migration tree into its actual owning repository. No unrelated refactoring was included.

## Migration execution order

1. Back up affected schemas/data and current function definitions. Pause CRM webhook/automation/pending workers and PMS outbound dispatchers through the existing operational controls; drain in-flight sends. Pause reservation/guest/payment writers for cutover. Do not add a code feature flag. Keep credentials unchanged.
2. CRM: apply `supabase/migrations/94_integration_capability_contract_v2.sql` after existing 93. Check-in and review-destination catalog keys are implemented; direct-review remains unsupported/inactive.
3. CRM: apply `supabase/migrations/20261126180830_canonical_reservation_integration.sql`. This installs projection/completion/reconciliation, execution guards, preservation history, and resets the old watermark for a full pass.
4. PMS: apply `apps/rz-api/supabase/migrations/20261126180710_crm_canonical_reservation_integration.sql`. It acquires writer locks (10-second acquisition timeout), creates state/read/link/producer objects, replaces the existing emitter, attaches financial/guest/version callbacks and baselines every existing parent silently in the same transaction. Failure rolls back the migration transaction; resolve contention rather than forcing constraints early.
5. After the operator's database checks, release the paired PMS API and CRM code with workers still paused. PMS API must be available before CRM attempts canonical reads. Do not release the new callers against absent functions.
6. Run the existing initial-sync or reconciliation worker for **every active mapped property**, completing all pages before unpausing automation sends. This resolves historical children using authoritative aliases, installs unresolved-guest holds and repairs future timing schedules. Do not call the webhook processor to seed historical confirmations.
7. Inspect the preservation/history rows, source-version alignment, unresolved identities and queued jobs. Run the manual scenarios below. Resume writers and then delivery workers only after validation. Pending historical/unversioned events are deliberately non-replayable lifecycle evidence.

This is a coordinated release sequence for you to execute; none of it was run here. Do not apply CRM SQL to PMS or PMS SQL to CRM.

## Manual validation still required

Run API and CRM type checks and the existing reservation/provider/webhook/scheduler/worker/continuation suites after your migrations. Provider transport fixtures were updated to v2. Database/runtime acceptance remains unverified until you run it.

- Multi-room Booking.com, Airbnb, Agoda, MakeMyTrip/Goibibo and Walk-In creation/modification: one parent projection, complete aliases, one first confirmation, one update for partial cancellation, one cancellation for all rooms. Keep the existing atomic OTA and walk-in RPC boundaries; forcing deferred constraints early or splitting an operation across transactions is outside the producer contract.
- Same-status paid amount/balance changes, payment retries, partial payment, cancelled-stay refunds, ledger-only transactions, adjustment insert/soft-delete, profile-only guest changes and explicit guest unlink/relink. Verify source timestamp/version and outbox changes, including unknown OTA financial fields.
- Repeated and reversed states A→B→A across transactions must create new versions; duplicate callbacks/replayed operations must not. Repeat/reorder webhook versions; reject >bigint versions and cross-property aliases. Crash after projection, then retry completion; expiry/reclaim of a webhook attempt must not let the old claimant complete it.
- Change reservation, timezone or automation configuration after plan creation. Completion must retry rather than commit stale jobs. Race an execution against schedule upsert; an existing processing/completed job must not be restarted.
- Parent already present, one child present, several children present, different contacts, historical completed confirmations/timing jobs and failed jobs with errors: IDs/contacts/logs unchanged; original diagnostics preserved in reconciliation history; no duplicate sends.
- Ambiguous guests with already scheduled jobs, failed retry jobs, normal waits and contact-recovery waits: no contact actions. Resolve authoritatively and verify safe continuation. Reinstatement must suppress an old cancellation job. Newly unresolved identity during an execution must park before its next contact action.
- More than 100 rows, equal timestamps differing only below milliseconds, all-native pages, all-PMS pages and both streams; inclusive boundary replay; cursor repetition and later-page failure. Hold a writer transaction open while scanning, then commit it and verify the next incremental pass reads it.
- Service credential, disconnected account, host/property mismatch, inactive entitlement, revoked/expired token and absent session: reject safely. Anonymous/authenticated roles cannot read the new internal tables/view or execute Class E RPCs. No bearer URL/token appears in logs.

`supabase/tests/crm_reservation_identity_preflight.sql` and `supabase/tests/crm_reservation_context_contract.sql` in PMS are read-only operator checks. CRM's corresponding read-only checks are `supabase/tests/canonical_reservation_integration.sql`.

## Rollback and preservation

Pause all workers/senders and drain claims before rollback. Capture any new outbox deliveries and remote-send outcomes; never reset sent jobs for replay.

PMS: run `docs/sql/crm_integration_rollback.sql` manually in the PMS database. It removes the new trigger attachments and restores the three modified producer/publication functions from the live production definitions captured during this review. It restores the prior native trigger attachment. It intentionally retains state, operation, outbox, identity and check-in records. Take a fresh pre-application function backup too: the captured definitions are from 26 November, not proof against later drift.

CRM: `docs/sql/crm_integration_restore_functions.sql` restores the three replaced queue/execution functions while workers remain paused. Keep the additive columns and `crm_canonical_reconciliation_history`. That table preserves original reservation/job snapshots, including previous failure diagnostics. Do not delete aliases, canonical rows, contacts, jobs or logs to reverse a rekey. A per-row reversal must first verify that neither newer projection changes nor accepted sends would be overwritten; compare original external IDs against current unique keys. Restore only verified unsent jobs under operator review.

An application rollback alone is **not sufficient** after canonical IDs have been persisted: the old CRM reader expects room IDs and does not understand retained aliases. Keep old workers stopped until a compatible fix-forward or an explicitly reviewed mapping restoration is ready. No automatic destructive down migration is provided. Emails/WhatsApp messages already accepted remotely cannot be rolled back.

## Validation and genuine limitations

Both applications were statically type-checked. Migration SQL and PL/pgSQL were parsed offline, with CRM catalog row types represented as records for the PL/pgSQL parser. These checks do not establish database execution correctness. No tests, migrations, writes to live databases, deployments or merges were run.

No known missing credential, schema dependency or unresolved child-conflict algorithm blocks development. Genuine remaining release gates are your migration rehearsal, concurrency/provider/runtime tests and operational cutover. Existing schema-history drift requires explicit operator handling; do not use a blanket push. The provider has no verified direct review-entry URL; it returns unsupported and exposes the verified general trip destination separately. This does not block canonical reservation synchronization.

Scoped ESLint passed for PMS. CRM scoped ESLint reported zero errors and one existing unused-variable warning (`_skippedPhone` in reservation-sync.ts). No runtime tests were executed. The rollback snapshots preserve the previous function bodies with search_path normalized to the supplied rulebook.

## Changed files

Paths below are relative to their owning repository; A = added, M = modified, D = superseded draft removed.

### PMS

```text
M	apps/rz-api/src/app/v1/integrations/rz-crm/_lib/canonical-pms-data.ts
M	apps/rz-api/src/app/v1/integrations/rz-crm/_lib/unified-reservation-data.ts
M	apps/rz-api/src/app/v1/integrations/rz-crm/_lib/variables.ts
A	apps/rz-api/supabase/migrations/20261126180710_crm_canonical_reservation_integration.sql
M	docs/crm-reservation-integration.md
D	docs/sql/crm_emit_reservation_operation_v2.draft.sql
A	docs/sql/crm_integration_restore_functions.sql
A	docs/sql/crm_integration_rollback.sql
D	docs/sql/crm_read_master_checkin_v2.draft.sql
D	docs/sql/crm_reservation_context_view.draft.sql
D	docs/sql/crm_reservation_event_state.draft.sql
D	docs/sql/crm_reservation_event_trigger_cutover.draft.sql
M	supabase/tests/crm_reservation_context_contract.sql
```

### CRM

```text
A	docs/canonical-reservation-completion.md
M	docs/integration-capabilities-v2-rz-pms-review.md
D	docs/sql/crm_canonical_event_completion.draft.sql
D	docs/sql/crm_canonical_event_version.draft.sql
D	docs/sql/crm_canonical_projection_v2.draft.sql
A	docs/sql/crm_integration_restore_functions.sql
D	docs/sql/crm_rekey_pms_reservation_v2.draft.sql
M	integrations/rz-pms/API_CONTRACT_V2.md
D	integrations/rz-pms/supabase/migrations/001_crm_read_reservation_capabilities_v2.sql
M	src/lib/automations/engine.ts
M	src/lib/automations/pms-context.ts
M	src/lib/automations/pms-schedule-backfill.ts
M	src/lib/automations/pms-scheduler.ts
M	src/lib/automations/pms-worker.ts
M	src/lib/integrations/pms/canonical-reservation-reader.ts
M	src/lib/integrations/pms/initial-sync.ts
M	src/lib/integrations/pms/provider.ts
M	src/lib/integrations/pms/providers/rukiye-zara-variables.ts
M	src/lib/integrations/pms/providers/rukiye-zara.test.ts
M	src/lib/integrations/pms/providers/rukiye-zara.ts
M	src/lib/integrations/pms/reconciliation.ts
M	src/lib/integrations/pms/reservation-sync.ts
M	src/lib/integrations/pms/webhooks/event-processor.ts
M	src/lib/message-variables/runtime-resolver.ts
A	supabase/migrations/20261126180830_canonical_reservation_integration.sql
M	supabase/migrations/94_integration_capability_contract_v2.sql
A	supabase/tests/canonical_reservation_integration.sql
```
