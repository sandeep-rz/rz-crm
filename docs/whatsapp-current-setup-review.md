# WhatsApp current setup: limitations and issues

Reviewed 12 October 2026 against `docs/whatsapp-production-readiness-plan.md`, repository baseline `73c53f5`, and Supabase project `ideibnrtszjdrxsusnwc` through the connected CRM account.

**Verdict: NOT READY for a production coexistence rollout or a claim of proven horizontal scalability.** The core architecture is appropriate and the recent signup RPCs are well restricted, but there are confirmed security and reliability gaps. Some release requirements still need live evidence.

This was a read-only application/database review. No migrations, customer/provider changes, messages or destructive security probes were performed. Only review documentation was written.

## Evidence and its limits

- Live migration history includes 73–78. Whitespace-normalized function-body hashes match local migration sources for `finish_whatsapp_signup`, `begin_whatsapp_coexistence_sync`, `accept_whatsapp_coexistence_sync`, `capture_whatsapp_coexistence_event` and `process_whatsapp_coexistence_event`. Findings against those bodies apply to the deployed database, not just an unpublished migration.
- The two private ledgers deny anon/authenticated reads; inspected signup/coexistence RPCs deny execution to those roles. RLS is enabled on config and both ledgers. The config SELECT policy checks membership through an `auth.uid()`-bound helper; table SELECT grants alone do not mean public customer-data access.
- The import worker is scheduled every minute. Its previously checked 24-hour summary contained 1,440 successful executions.
- **Current data: one connected connection with no Embedded Signup/coexistence metadata, two pending signup attempts, zero coexistence receipt rows.** An empty worker can succeed while import, synchronization and throughput remain untested. This snapshot does not prove historical onboarding never occurred; it provides no current coexistence success evidence.
- **171 focused tests passed again** across ten backend, route, webhook, SDK and settings test files using bundled Node 24.19.0. These tests do not cover every failure identified below.
- Two synthetic local probes reproduced loss of location/reply fields and a sync helper reporting acceptance when both database claims return false. The probes used fabricated payloads and mocked database/provider calls; no Meta requests were made.
- Supabase security/performance advisors were inspected. Warnings were evaluated rather than treated as automatic vulnerabilities or reasons for indiscriminate schema changes.

## Confirmed issues

### 1. P1 — Older privileged maintenance RPCs are callable without signing in

Live catalog grants and function definitions confirm that `_bcast_bump`, `claim_ai_reply_slot`, `record_webhook_failure`, `merge_duplicate_contacts` and `merge_duplicate_conversations` are owned by postgres, run as SECURITY DEFINER, allow execution by anon/authenticated, and contain no caller or workspace authorization check.

Impacts differ: callers knowing a row ID can change broadcast counters, consume an AI reply allowance, or increment failure counts and potentially disable a webhook endpoint. The merge functions operate across the database. In particular, `merge_duplicate_conversations` groups by account/contact without including the WhatsApp connection, so distinct-number conversations introduced by multi-connection support can be treated as duplicates.

This is a confirmed authorization defect from definitions and grants, not a claim of observed exploitation. None of these mutating functions was invoked during the review. Trigger functions and membership helpers flagged by the advisor were not automatically included as vulnerabilities: some require trigger context or check `auth.uid()` correctly.

Evidence: migrations `005_broadcast_counts_incremental.sql:36`, `022_contact_phone_dedup.sql:38`, `028_webhook_endpoints.sql:91`, `029_ai_reply.sql:118`, `036_conversation_contact_dedup.sql:41`, plus live definitions/grants. [Supabase remediation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

Required action: first map legitimate callers, then use one forward migration to revoke inappropriate execution while preserving trigger/internal use. Retire or correct the obsolete conversation merge behavior. Do not blanket-revoke every SECURITY DEFINER function or edit historical migrations.

### 2. P1 — Ordinary WhatsApp messages/statuses are acknowledged before durable capture

`src/app/api/whatsapp/webhook/route.ts:254–296` persists coexistence deliveries first, but ordinary messages, statuses and template handling execute after the HTTP 200 response through `after()`. The route has a 60-second duration. A timeout, process termination or downstream error can leave an acknowledged delivery incomplete with no stored raw work item to recover.

There is another recovery boundary: after an ordinary message is inserted, duplicate handling at lines 875–893 returns before later unread/flow/automation steps. A failure between insertion and those steps cannot be repaired merely by replaying the payload; it needs stage-aware idempotency.

`after()` is useful for keeping work alive after a response, but it runs only within the configured platform duration. [Next.js documentation](https://nextjs.org/docs/app/api-reference/functions/after).

Required action: durable capture before ACK for supported ordinary deliveries, plus recoverable/idempotent processing stages. Extend the established webhook processing architecture and preserve one canonical message store and automation engine.

### 3. P1 — A crash after finalization can strand the one-time sync start

The route commits `finish_whatsapp_signup` before it calls `resumeCoexistenceSync` (`embedded-signup/route.ts:413–427`). If the process stops between those operations, the connection and attempt are complete but synchronization has not started.

Replaying a completed attempt returns immediately at line 273; the discovery GET excludes complete attempts. The installed cron job imports existing receipts but does not initiate missing sync requests. Manual `action: sync` can help before the deadline, but the normal recovery path has no autonomous continuation for this gap.

Required action: persist pending synchronization work and resume it through existing scheduling/recovery mechanisms, preserving one-time intent protection. Replayed completed signup should expose/reconcile sync state without repeating accepted or uncertain requests.

### 4. P1 — No shared per-number sending budget across instances and features

`src/lib/rate-limit.ts` explicitly implements a process-local map. Inbox and broadcast routes use separate per-user keys. `broadcast-core.ts:436` calls Meta directly using the prepared plan; no shared number budget is present in the inspected send paths.

Sequential sending within one broadcast does not coordinate other broadcasts, agents, automation workers or server instances. This prevents a credible multi-instance capacity guarantee and makes the documented coexistence number limit relevant to ordinary workloads, not just large campaigns.

Required action: a shared per-number send budget at the common send boundary, with safe rejection backoff. Preserve the existing unknown-outcome resend protections. Raising route request limits or adding more workers alone will not solve this.

### 5. P2 — Already-running broadcasts can outlive offboarding state

`connection-resolver.ts:130` rejects a disconnected coexistence connection when resolving it. However, a prepared broadcast stores the phone ID/token and `deliverBroadcast` subsequently sends the recipient list without re-reading connection lifecycle status. A lifecycle webhook that disconnects the connection after planning does not stop that running loop locally. Meta may reject further messages, but the application does not enforce the stated pause for that in-flight work.

Required action: check current connection/lifecycle eligibility at bounded send checkpoints, integrated with the shared send budget. An already-issued network request cannot be recalled; define the pause guarantee accordingly.

### 6. P2 — Known but not yet classified coexistence events can be discarded before ACK

The deployed capture function only inserts receipts when config metadata already says coexistence (`78_whatsapp_coexistence_webhooks.sql:50–51`). Standard phone-number-first signup initially stages `cloud_api` metadata, and the backend promotes it to coexistence only after Meta activation verification.

A mapped echo or lifecycle delivery in that interval is skipped. Phone-less ambiguous lifecycle events are counted/logged and skipped as well; they are not retained for later resolution. The webhook still ACKs. This is a code-confirmed discard path; its frequency and Meta delivery ordering were not tested live. Explicit coexistence staging already has the correct mode and is not affected in the same way.

Required action: retain safely attributable staged/unresolved events for later reconciliation without guessing a workspace or broadcasting a WABA event to every number. Add activation-overlap tests before changing routing.

### 7. P2 — A busy connection can stop a drain call before other tenants are considered

The deployed worker selects a due receipt, then attempts a connection row lock with SKIP LOCKED. If that connection is locked, it returns from the entire function (`78_whatsapp_coexistence_webhooks.sql:74–75`). It does not move on to another connection's due receipt.

This avoids waiting/deadlock cycles, but repeated contention at the oldest eligible receipt can repeatedly cut short otherwise useful drain calls. All 25 batches also share the outer function transaction and retain acquired locks until it ends; they are not 25 separately committed transactions.

Required action: prove and improve fair draining across connections while retaining safe lock ordering and short transactions. Treat this as a confirmed scheduling limitation, not measured production starvation; the current ledger is empty.

### 8. P2 — Sync outcomes lose distinctions needed for useful recovery

`resumeCoexistenceSync` starts with an acceptance boolean based on the old config snapshot, and simply continues when `begin_whatsapp_coexistence_sync` returns false. That false value can mean already requested, disconnected, or deadline expired. A synthetic local probe with both claims returning false produced `accepted: true` and zero Meta calls.

All request/save failures are also caught identically, leaving unconfirmed intent. Avoiding blind retries is correct for uncertain acceptance, but definite rejection versus unknown network/persistence failure is not retained for support or safe recovery. The frontend at `whatsapp-embedded-signup.tsx:218` ignores the backend's `sync_pending` field and always displays the generic connected/payment message.

Required action: return structured current states, preserve safe numeric error/support metadata, distinguish definite rejection from uncertainty, and show an actionable pending-sync state. Do not turn these distinctions into automatic retries of one-time requests.

### 9. P2 — App echoes/history lose richer message content

The parser primarily stores body/caption, media ID/type, direction and delivery state (`coexistence-webhook.ts:34–80`). It does not preserve reply context, location coordinates, interactive details, or edit/revoke semantics. Unknown types become text placeholders.

A synthetic location echo containing coordinates and reply context became a location record with text `[location]`, no coordinates and no reply reference. The import worker has no corresponding rich-content preservation step.

Required action: explicitly define the supported message types and preserve/render the fields needed for them in canonical messages. Do not promise full Business app mirroring until payload and UI coverage agree. Handle edit/revoke events as updates when the official contract supplies them, rather than additional placeholder messages.

### 10. P2 — Retention and discovery are unbounded

Completed receipts have their records cleared, which is good for sensitive-content retention, but receipt rows/replay keys remain indefinitely. Signup attempts have expiry/discard fields but no scheduled retention cleanup was found in the repo or the five installed cron jobs. Saved-setup GET lists every non-complete, non-discarded attempt without a limit or expiry filter.

Effects at scale: growing table/index size, accumulating expired setup cards, and unnecessary reads. There are currently only two attempts and zero receipts, so this is a growth limitation rather than present capacity exhaustion.

Required action: bounded discovery and an explicit retention policy that preserves uncertain-registration barriers and necessary dedupe identities. Do not simply delete all expired attempts or all processed receipt keys.

### 11. P3 — Minimalist setup and live status are incomplete

The selected default is still `cloud_api` (`whatsapp-embedded-signup.tsx:151`), contrary to the user's confirmed Business-app-first priority. Preparation then launch requires separate user clicks. That protects popup activation; simplification must preserve synchronous launch from a prepared click.

The coexistence explanation is a long upfront paragraph; a successful connection has no primary Open inbox action in the inspected signup component. Capability/status data refreshes on explicit invalidation and focus after 60 seconds, with no sync polling/realtime subscription. Progress can remain stale while the user stays on the setup screen.

Required action: Business-app-first default, concise essential notice plus expandable details, clear pending/connected states, scoped refresh while synchronization is active, and a primary next action.

## Limitations and unresolved release evidence

- **Meta configuration:** app approval/live status, required advanced access, actual configuration-selected v4, allowed domains and app-level webhook topic subscriptions are still unverified. WABA subscription verification is not proof that every required app topic is configured.
- **Server/API versions:** the plan's simple v21-versus-v26 description misses that coexistence phone verification and sync explicitly use v26, while the generic signup helper and other existing paths use v21. Mixed versions are not automatically a bug; endpoint compatibility and retirement dates still need a deliberate policy.
- **Customer billing:** code intentionally stores `not_verified`. Signup success cannot establish payment readiness or the actual customer-direct billing arrangement. Preserve that honest distinction in the UI.
- **Eligibility/provider transfers:** no evidence verifies this Meta app's coexistence approval or an AiSensy/other provider transfer/share path for a particular number. Do not disconnect existing service to discover eligibility.
- **Documented product constraints:** the earlier official-doc review identified the one-time sync window, per-number coexistence throughput, history/media range limits, omitted groups and linked-device/app feature changes. These must be reflected in promises and test expectations, not described as application bugs. [Meta coexistence guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).
- **Full schema/load/browser:** no current complete-schema regression run, induced crash/load test, production-equivalent browser signup, controlled messaging/billing test or authenticated cross-tenant runtime test was performed. Passing unit tests and catalog inspection do not replace these gates.
- **Environment:** the CRM project's production/staging role, deployed build/runtime, host timeout and operational backup/restore plan remain unidentified. Local shell Node 20.17 previously failed UI-test initialization; bundled Node 24 passes. Verify actual CI/hosting runtime independently.

## Advisor interpretation

Security advisors report private ledgers with RLS and no policies. For service-only ledgers that also revoke anon/authenticated privileges, this is intentional; adding public policies would weaken their boundary.

The advisor flags 57 unindexed foreign keys project-wide, including signup account/reconnect references and several messaging references. These are candidates for EXPLAIN/workload review, not 57 confirmed bottlenecks. The receipt table already has a connection-ID index; assess whether it sufficiently serves the composite FK predicate before blindly adding another. [Index advisory](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).

Unused-index warnings on a largely unused coexistence feature do not justify dropping those indexes. Mutable-search-path warnings and unrelated vector/AI warnings should be tracked separately from the verified signup function search paths.

## Changes needed in the plan

1. Add a **security gate first** for exposed mutating maintenance RPCs. It was missing from the initial plan.
2. Mark schema deployment/access and the five verified function bodies as confirmed. Keep actual Meta traffic and import performance unverified; replace “worker runs successfully” as a readiness proxy with processed/failed/oldest-work evidence.
3. Specify the crash-after-finalization sync gap, activation-overlap capture, stage-aware ordinary-message recovery and in-flight offboarding guarantees as concrete failure scenarios.
4. Define safe outcomes for unsupported message types, empty history, refused sharing, no completion webhook, deadline expiry and ambiguous one-time request acceptance.
5. Treat fair worker scheduling, shared per-number budgets and retention as prerequisites before horizontal scaling, not later optimizations.
6. Keep the proposed p95 ACK times and 100,000-message fixture explicitly provisional. Validate realistic maximum payloads and workload sizes before turning those values into production SLOs.
7. Reconcile stale wording in the initial plan and older signup guide: management access is resolved, coexistence is implemented, and new migrations must be forward-only because 73–78 are already applied.

Recommended order: privileged-RPC security → ordinary webhook durability and sync recovery → lifecycle/capture edge cases → shared sending budget and worker fairness → richer content/retention → minimalist UX → complete-schema and real staging validation → production canary.

The existing architecture can be retained. None of these findings requires a second CRM connection store, webhook endpoint, automation engine, or unrelated provider migration.
