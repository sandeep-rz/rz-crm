# Final canonical reservation integration review — 27 November 2026

## Scope and completion

Reviewed both complete PR diffs against their actual main bases: PMS PR #25, `65e5975013a9eab4f1f45c003cdfc95aaffa43cd`; CRM PR #1, `67a16e8e0b9ce46191f21dfdf381ebe26302f2c8`. Corrections are on the existing branches. The implementation is connected to the API, synchronization workers, webhook completion, scheduling, sender gate and wait-resumption paths. No migrations, database mutations, runtime tests, deployments or merges were performed. Live Supabase catalogs were read through MCP; the July dump was not used.

## Final database architecture

**PMS adds one permanent table; CRM adds zero.** Existing PMS `domain_events` remains the only outbox. Existing CRM `pms_reservations`, jobs, logs, pending executions and contact identities remain authoritative.

| Object | Decision and purpose |
| --- | --- |
| PMS `reservation_event_state` | Retained shared native/parent lifecycle, confirmation latch, positive bigint version and SHA-256 hash. Composite source identity, generated source-specific foreign keys, property FK and validation trigger prevent orphaned/mis-scoped identity. No persisted guest/payment snapshot. RLS; service-only access. |
| Previous CRM-specific state, native-confirmation and operation-ledger proposals | Consolidated into shared state or removed. Existing source revision/request deduplication remains in the mutation paths. |
| PMS parent and native CRM context views | Retained service-only invoker views. Parent rooms/guest/version and native guest/financial enrichment each come from one SQL statement, eliminating mixed-snapshot enrichment. No second projection table. |
| PMS shared producer, normalizer, timestamp/watermark functions and trigger gateways | Retained for final-state hashing, both source kinds, transaction-safe publication, financial and guest-only mutations and incremental scans. Existing native emitter delegates to the shared producer. Known set arrays are sorted; occupancy categories remain distinct; bookkeeping timestamps are excluded. |
| PMS check-in/read functions | Retained, scoped to validated host/property/reservation and active token/session. Master links reuse existing master sessions; no new token table. |
| CRM `canonical_source_version`, `canonical_reservation_id` | Retained on existing projection. Positive version constraint, same-account FK, no-self-reference constraint and partial alias index support actual stale-event and alias-history queries. |
| CRM reconciliation/projection/completion RPCs | Retained service-only invokers: scoped identity reconciliation, atomic projection+version, atomic scheduling+event completion. Existing begin/claim/schedule functions extended rather than adding another queue. |
| CRM `crm_canonical_reconciliation_history` | Removed from the unapplied migration: it was backup-only. Reconciliation now leaves **all job columns untouched**, including status, attempts, lease, completion and last_error. |
| CRM capability snapshot/config columns and binding constraint | Removed as unused; migration 94 now only updates the existing variable catalog. No capability cache or feature flags. |

The shared PMS table is necessary beyond outbox retention: a permanent confirmation latch and version cannot safely be reconstructed after event archival. Its hash stores no PII. Views, trigger callbacks and mutation RPCs reuse actual business rows; no inventory or source revision tables are replaced.

## Historical reconciliation and recovery

A verified authoritative parent/child alias list selects the existing parent or oldest matching child deterministically. The winner retains its CRM UUID and contact; other reservations retain their UUIDs, contacts, jobs and logs and point at the winner. Native-source collisions, another tenant/property and aliases already assigned elsewhere are rejected. `metadata.canonical_previous_external_id` retains the original external identity without replacing an earlier saved identity. Only a small identity/hold marker is stored; no reservation/job snapshots are copied into metadata.

Alias jobs keep their original scheduled/failed/processing/completed states and diagnostics. Claim and execution gates exclude aliases and pending identity transitions. Scheduler calls for an alias perform no job mutation. Canonical scheduling also checks completed/processing alias history **and retry-blocked failed history with external-action evidence**; it does not create a second message merely because the original job is failed. Existing failed canonical jobs retain their status and diagnostics; their existing retry/execution machinery owns recovery. Schedule upserts retain prior error diagnostics even when an eligible schedule is refreshed. The same rules apply to legacy rows encountered in later incremental reconciliation, not only initial migration.

A verified operator backup replaces the backup table's recovery role. CRM `scripts/backup-canonical-reconciliation.sh NEW_PRIVATE_DIRECTORY` uses normal libpq credentials and a full custom-format pg_dump, restrictive filesystem modes, required table-data inventory, pg_restore archive-list verification and SHA-256 manifest. It never prints credentials. Use an encrypted private destination outside the repository. Archive/readability checks do not prove recoverability: restore into an isolated database and verify counts, identities, contacts, jobs/errors, logs, pending executions and constraints before cutover. Do not restore into the source database. Take an equivalent PMS backup and archive deployed function definitions, migration history, application SHAs and delivery state. Repeat backups before later operator reconciliation if point-in-time projection recovery is required: mutable projections are not a historical snapshot archive. The reconciliation itself retains identities and job diagnostics permanently.

## Correctness and compatibility corrections

- Native requested/pending writes still advance synchronization state but do not emit guest-facing lifecycle events before confirmation/cancellation. First confirmation keeps the original `reservation:rz:{id}:confirmed` idempotency key; the durable latch prevents a second confirmation after cancellation/reinstatement or outbox pruning.
- Both producers lock the actual source row. Final-state digest/version and the existing outbox write share one transaction. Identical callbacks converge; committed A → B → A creates distinct versions. Historical baseline is silent and writer-locked. Keep existing mutation RPC transaction boundaries and deferred constraints; forcing callbacks early inside a multi-room change is unsupported.
- Existing Channex and walk-in inventory commit/revision RPCs remain intact. Live definitions enforce revision deduplication before writes; a new create request with new IDs is still a distinct business operation. No inventory/availability mutation interface was refactored.
- Financial records, partial payments, refunds, adjustments, guest snapshots/profiles and explicit clears reach the common producer through their attached callbacks. Parent room statuses determine partial versus total cancellation. API financial values and native/parent ID contracts remain compatible.
- Parent source versions are positive decimal bigint strings end to end; no JavaScript numeric conversion. Projection+version are one RPC transaction. Projection updated_at strictly advances even for rapid writes. A newer/equal persisted version does not imply webhook completion: equal-version retries can complete the separate recoverable transaction.
- Completion validates claim attempt, source version, current projection timestamp, timezone and automation configuration while inserting jobs and completing the event atomically. Stale/reordered lifecycle events cannot cancel reinstated schedules. Superseded events are ignored before unresolved-guest retry handling.
- Lists use independently bound native/parent cursors, full PostgreSQL timestamp precision and inclusive incremental boundaries. Providers reject repeated/malformed cursors and inconsistent has_more/next_cursor responses. Watermarks only advance after all pages succeed. The SQL watermark is bounded by open transaction start times so a later commit is replayed on the next inclusive pass.
- Ambiguous identity is held conservatively. Existing scheduled/retry jobs, execution gates, contact actions and resumed waits refresh authoritative context. Inactive property or disconnected integration rejects context. Old contacts are retained during unresolved projection without being used for guest-facing actions. No automatic contact merging or name/email/phone inference was added.
- Existing v1 variable resolution stays compatible; v2 is opt-in. Implemented master/native check-in and general review destinations are connected to the real resolver. Direct review-entry URLs remain explicitly unsupported, not fabricated. Bearer links are not logged; master base URLs reject userinfo.
- Removed unused alternate canonical reader, reconciliation planner, trusted-capability router, future capability binding/config machinery and duplicate TypeScript lifecycle classifier. Actual SQL producer/provider/scheduler paths remain. Superseded SQL drafts are consolidated into the three ordered migrations.

## Security review

Followed the original Rukiye Zara Supabase Security Rulebook. New workflow RPCs are Class E, explicitly revoked from PUBLIC/anon/authenticated and granted only to service_role. Invoker mode is used where existing service grants suffice. Live PMS grants showed service_role lacks private schema usage and emit_domain_event execution: the validated shared producer therefore uses SECURITY DEFINER with fixed public/pg_temp search_path, calling owner-only internals without broadening their grants. Private normalization remains owner-only. Other definer gateways have fixed search_path and explicit execution rules. New views/table are not publicly readable. Existing credential, session, host/team permissions and entitlement architecture is preserved; API scope checks precede privileged operations. No global helper/RLS cleanup or unrelated authorization rewrite was performed.

## Migration execution sequence — operator only

1. Pause reservation writers and all CRM synchronization, webhook delivery, scheduling and send workers; drain active claims. Record accepted external sends and current application SHAs. Take and restore-rehearse verified backups as above.
2. Compare live schemas and migration history with staged SQL. CRM history was through 93. PMS production's latest registered migration was `20261121164422`, DEV `20261121164359`, despite later parent/check-in objects already existing. Resolve history drift explicitly; **do not blanket db push or replay older migrations**. Capture current function definitions for rollback.
3. CRM: apply `supabase/migrations/94_integration_capability_contract_v2.sql` after existing 93.
4. CRM: apply `supabase/migrations/20261126180830_canonical_reservation_integration.sql`.
5. PMS: apply `apps/rz-api/supabase/migrations/20261126180710_crm_canonical_reservation_integration.sql`. Writer locks, 10-second acquisition timeout and silent baseline are in its transaction. If lock acquisition fails, resolve contention and retry; do not bypass locking or force deferred constraints early.
6. Deploy paired applications manually with workers paused; ensure PMS v2 API is available before CRM canonical readers. Complete a full initial/reconciliation pass for every active mapped property. Old watermarks are reset by the CRM migration; do not seed historical confirmation events.
7. Verify aliases, held guests, versions, schedules and backup preservation. Execute the checks below in an approved test environment first. Resume normal writers and then delivery/senders only after operator acceptance.

No migration has been applied by this review. These files belong to separate databases; their filename timestamps do not establish cross-database ordering.

## Rollback instructions

Pause/drain every worker and sender again and capture post-cutover accepted sends. Messages already accepted remotely cannot be undone. Prefer a compatible fix-forward.

PMS `docs/sql/crm_integration_rollback.sql` removes new trigger attachments and restores captured old producer/publication functions. `docs/sql/crm_integration_restore_functions.sql` is the captured function source. Verify against the fresh pre-cutover catalog first. Retain reservation_event_state, its versions/confirmation latches, views, existing outbox and check-in records; never re-baseline/reset the retained latch or delete reservation data during application rollback.

CRM `docs/sql/crm_integration_restore_functions.sql` restores the three replaced queue/execution functions while workers remain stopped. Keep additive columns and all reservation/contact/job/log records. There is no reconciliation-history table to restore. For identity reversal, use saved canonical_previous_external_id plus the verified pre-operation backup; check current unique keys, newer projection updates and accepted sends before any targeted operator restoration. Reconciliation never overwrites job statuses/errors, so no automated job reset is necessary or safe. Full snapshot recovery comes from the backup, not metadata. Do not restore an entire database over newer accepted sends without a separate recovery plan.

Old CRM workers do not understand canonical parent IDs/retained aliases. An old application deployment alone is insufficient after rekeying; keep workers paused until a compatible fix or reviewed mapping restoration is complete. No destructive down migration or automatic record/contact merge is provided.

## Validation and manual acceptance

Static results: both API and CRM TypeScript checks passed with incremental state disabled. Both Next compile-mode production builds passed; this verifies bundling, not prerender/provider/runtime behavior. SQL and PL/pgSQL parsed offline, replacing catalog %ROWTYPE references with record for parsing; this is syntax validation, not live function compilation/execution. Scoped ESLint passed with zero errors or warnings across each full PR TypeScript diff; bash -n validated the backup script and git diff --check passed in both repositories. Regression tests were added/updated but **not executed**, as requested.

Operator checklist:

- Apply migrations on an isolated current-schema clone first; validate grants/RLS as anon/authenticated/service roles and cross-account/host/property rejections. Review both repositories' SQL contracts and backup restore counts.
- Native pending → first confirmation → cancellation → reinstatement, historical baseline and pruned outbox: exactly one lifecycle confirmation. Exercise unchanged callbacks, retries and A → B → A under concurrency.
- OTA and walk-in, single/multi-room create/modify/revision replay; partial/all-room cancellation; inventory/availability remains correct. Keep existing source operation IDs and transaction boundaries.
- Payment-only, refund-only, partial-payment, adjustment insert/delete and guest/profile-only changes; explicit clears and unresolved identity; verify version/outbox/projection and financial values.
- Parent/one child/multiple children with differing contacts and scheduled/failed/processing/completed jobs; original UUIDs, contacts, errors, attempts and logs unchanged. Execute CRM canonical_reconciliation_preservation.sql rollback-only fixture on the test clone. Test external-action retry-blocked failed alias jobs prevent duplicate sends.
- Duplicate/reordered/bigint versions; crash between projection and completion; reclaimed lease rejects old claimant; racing reservation/config/timezone change retries completion safely.
- Ambiguous guests with already scheduled jobs, retries, normal waits and contact-recovery waits: no guest-facing action; authoritative resolution resumes safely. Disconnect integration/deactivate property mid-wait.
- More than 100 rows, both streams, equal timestamps differing below milliseconds, later-page failure/repeated/malformed cursor and a writer held open across scans. Watermark never skips the late commit.
- Existing v1 variables/templates, v2 links, native/master check-in sessions, expired/revoked tokens, unsupported direct-review keys and safe review destination. Verify no bearer links or private guest payloads in logs.

No known incomplete development path remains from this review. Migration-history reconciliation, backup restore rehearsal and manual database/concurrency/provider/E2E acceptance are genuine **release gates**, not completed tests. Production behavior remains unverified until those gates pass.

## Migration object declaration inventory

The following declarations are in this repository’s unapplied migration files; replaced functions extend the existing runtime, rather than installing parallel infrastructure. Inline table constraints are described above.

```sql
ALTER TABLE public.pms_reservations ADD COLUMN canonical_source_version bigint
ALTER TABLE public.pms_reservations ADD COLUMN canonical_reservation_id uuid;
ALTER TABLE public.pms_reservations ADD CONSTRAINT pms_canonical_same_account
ALTER TABLE public.pms_reservations ADD CONSTRAINT pms_canonical_not_self CHECK(canonical_reservation_id IS DISTINCT FROM id);
CREATE INDEX pms_reservations_canonical_history ON public.pms_reservations(canonical_reservation_id) WHERE canonical_reservation_id IS NOT NULL;
CREATE FUNCTION public.crm_reconcile_pms_reservation_v2(
CREATE FUNCTION public.crm_save_canonical_projection_v2(
CREATE FUNCTION public.crm_complete_canonical_event_v2(
CREATE OR REPLACE FUNCTION public.begin_pms_automation_execution(p_job_id uuid, p_attempt_count integer, p_contact_id uuid, p_expected_reservation_updated_at timestamp with time zone)
CREATE OR REPLACE FUNCTION public.claim_automation_trigger_jobs(p_limit integer, p_stale_before timestamp with time zone, p_now timestamp with time zone)
CREATE OR REPLACE FUNCTION public.upsert_pms_automation_schedule_jobs(p_jobs jsonb)
```

## Complete PR changed-file manifest

Paths are relative to this repository. A/M/D follow git diff against the reviewed main base.

```text
A	docs/canonical-reservation-completion.md
A	docs/integration-capabilities-v2-rz-pms-review.md
A	docs/reservation-event-architecture.md
A	docs/sql/crm_integration_restore_functions.sql
A	integrations/rz-pms/API_CONTRACT_V2.md
M	src/lib/automations/engine.ts
M	src/lib/automations/pms-context.ts
M	src/lib/automations/pms-schedule-backfill.ts
M	src/lib/automations/pms-scheduler.test.ts
M	src/lib/automations/pms-scheduler.ts
M	src/lib/automations/pms-worker.ts
A	src/lib/integrations/capability-contract.test.ts
A	src/lib/integrations/capability-contract.ts
M	src/lib/integrations/pms/initial-sync.ts
M	src/lib/integrations/pms/provider.ts
M	src/lib/integrations/pms/providers/rukiye-zara-variables.ts
A	src/lib/integrations/pms/providers/rukiye-zara-variables.v2.test.ts
M	src/lib/integrations/pms/providers/rukiye-zara.test.ts
M	src/lib/integrations/pms/providers/rukiye-zara.ts
M	src/lib/integrations/pms/reconciliation.ts
M	src/lib/integrations/pms/reservation-sync.ts
M	src/lib/integrations/pms/variable-resolver.ts
M	src/lib/integrations/pms/webhooks/event-processor.ts
M	src/lib/message-variables/runtime-resolver.ts
A	supabase/migrations/20261126180830_canonical_reservation_integration.sql
A	supabase/migrations/94_integration_capability_contract_v2.sql
A	supabase/tests/canonical_reservation_integration.sql
A	scripts/backup-canonical-reconciliation.sh
A	src/lib/automations/pms-context.test.ts
A	supabase/tests/canonical_reconciliation_preservation.sql
```
