# Dashboard metrics and automation reply-wait review

## Verdict

Adopt the response-metric corrections first. Adopt useful dashboard cards incrementally while retaining the current RZ interface. Adapt automation reply-wait only after adding conversation-scoped, durable claim/continuation handling to the existing engine. Do not cherry-pick either feature wholesale.

This is a review, not an implementation. No application file, migration, Git ref or hosted service was changed. This document is the only repository addition.

## Reviewed baseline

- RZ: `develop`, `a240e21` (clean at review start), matching the local `origin/develop` tracking ref. Theme/filter commit `307996b`, security/AI/flow integration `73a0ef9` and latest Inbox/webhook integration `a240e21` are all ancestors of HEAD.
- Upstream: `34bce1a8abf56281505d90bac165123b6ab7d51a`, verified with a read-only live `git ls-remote upstream refs/heads/main` during this review. Local upstream objects match that revision.
- Dashboard: `1ba1221` plus corrective `a20253a`; final upstream migration `059_dashboard_overview.sql` and final source reviewed, not just the initial commit.
- Reply-wait: `270a7de`, migration renumbering `9371738`, supporting translation changes and null-contact/error fix `fe94ece`; final upstream engine reviewed.
- Verification: six existing focused suites, **131 tests passed** (dashboard queries/dates, automation engine, pending worker, activation validation and durable webhook runtime). These establish the current regression baseline; they do not prove the optional upstream features work in RZ. No database migration, real provider call or browser E2E was run.

## Response metrics: useful correction, recommended first

Current `src/lib/dashboard/queries.ts:193` selects conversation, sender and timestamp for response calculations, without status or AI attribution. Its pairing loop accepts any non-customer message as a response. A deterministic automation acknowledgement can therefore end the measured wait before a human answers; failed sends are also eligible. For example, customer at 10:00, bot acknowledgement at 10:01, human at 10:15 measures one minute in this algorithm, rather than the human's fifteen minutes. This example is derived from the source, not a live dataset reproduction.

Upstream `a20253a` separates non-failed human and AI replies, keeps deterministic acknowledgements from clearing Waiting, and scopes deal outcome statistics by pipeline. These corrections are useful without requiring removal of the current dashboard.

Required RZ adaptations:

1. Define human and AI reply series independently, excluding failed sends and deterministic flow/automation messages. Preserve timestamp-plus-ID ordering and existing pagination. Keep outbound volume a separately defined metric rather than silently applying response exclusions everywhere.
2. Preserve Coexistence provenance. `79_whatsapp_runtime_hardening.sql:405` imports messages with `coexistence_metadata.history` and represents app-origin outbound messages as `sender_type='agent'`, generally without a CRM teammate identity. These cannot automatically become attributable CRM staff replies. Decide whether imported history belongs in historical volume and report unattributed app replies separately from per-agent performance.
3. The existing manual persistence RPC in migration 87 does not persist `sender_id`. Upstream's sender change is not sufficient for RZ because we use this RPC. Add verified actor attribution through the existing authorized function, preserving its atomic insert, frozen template snapshot, replay/status rules and agent handoff. Never fabricate teammate identities for old rows or app echoes.
4. Use the configured workspace/user timezone for CRM reporting; the upstream dashboard passes the browser timezone. PMS scheduling must retain property-timezone semantics.

## Dashboard: useful features, broad replacement rejected

Useful additions: Waiting, unassigned, failed-send attention cards, reply queue, configurable reply target, comparable-period KPIs, per-pipeline outcomes, separate AI/team statistics and connection health. A consolidated account-scoped RPC could also reduce browser queries.

A direct port would remove existing quick actions, metric cards, conversation chart, pipeline donut and response chart. It changes settings, Inbox filters, shared chart colors, translations, message persistence and schema together. That exceeds a safe additive integration.

Specific compatibility findings:

- **Membership:** upstream migration 059 derives the active account from `profiles`, which is compatible with our current selected-account pointer only when the existing membership contract remains enforced. However, its team CTE and setup member count enumerate `profiles.account_id`; RZ membership lives in `account_members`. A teammate currently switched to another workspace would be omitted. Join account memberships to profile identity, preserve role checks, and clear/refresh all dashboard state on account switches.
- **Coexistence and window warnings:** upstream backfills and triggers `last_inbound_at` from every customer message, with no history exclusion; its window-closing counts and Inbox filter use that timestamp. A recent imported history message can therefore produce a misleading live service-window warning. Separate historical reporting timestamps from live window eligibility and reuse RZ's existing history exclusion. The same import policy must be used in backfill, triggers, queue RPC and Inbox filters.
- **Multiple WhatsApp numbers:** upstream health API queries one account configuration using `maybeSingle()`. RZ supports multiple configurations; select an authorized connection or return clearly identified per-number results through the existing resolver. Disconnected/deleted connections and retained historical conversations need explicit handling.
- **Colors and interface:** retain existing forest/gold tokens, reservation filters and navigation. Add dashboard styles through current tokens; do not replace globals, settings sections or catalogs wholesale.
- **Persistence and database changes:** add forward RZ migrations after the existing chain; do not copy upstream migration numbers or modify migrations 86/87. Review backfill timestamps and trigger side effects against the full RZ schema before rollout. The upstream backfill disables update triggers temporarily; verify exact trigger names and ensure a failure cannot leave a partially applied change.

Recommendation: retain the current widgets initially, correct metrics, then add an attention/reply queue section and optional reporting cards. A complete layout redesign can follow as an explicit product change.

## Automation wait-for-reply: useful, requires stronger integration

Behavior: a Send Buttons or Send List action with the option enabled sends its menu and parks that run. The next eligible customer reply supplies new message text/interactive ID to the remaining conditions/actions. Flows retain priority; a reply consumed by the parked automation suppresses normal content triggers and AI for that delivery. Relationship-level triggers remain separate. Upstream expires unanswered waits after 24 hours without sending a fallback. This is a run deadline, distinct from WhatsApp send eligibility.

The existing timed Wait only delays execution; an automation's current Interactive Reply trigger starts another run. Flows already support interactive progression, so use them today where appropriate. Reply-wait is useful for keeping a simple existing automation's menu and branches in one run.

Required changes before porting:

1. **Match the correct conversation/number.** Upstream `resumeAwaitingReply` filters by account/contact only and overwrites the stored conversation with the incoming one. `parkForReply` also supersedes all waits for that contact across the account. In RZ, a shared contact can have separate conversations on separate numbers. Scope matching and superseding to account, contact, conversation and its selected connection. Check inbound identity/time against the wait so an older delayed delivery cannot answer a newly created menu. Correlate interactive message context/IDs where available; define how typed replies are accepted.
2. **Make park/supersede atomic.** Upstream performs a superseding UPDATE and a separate INSERT; concurrent menus can each insert an awaiting row. Serialize the operation and enforce one current wait per intended scope. Prevent a sufficiently fast reply from being lost in the send-to-park gap, while never creating an executable continuation for a rejected send.
3. **Reuse our durable webhook stages.** RZ dispatch lives in `src/lib/whatsapp/webhook-processor.ts:930`, with persisted `deliveryStage` outcomes. Add a reply-resume stage after flow handling and before normal automation/AI dispatch. Persist whether the reply was consumed, so a replay cannot fall through after its wait has already been completed. Do not copy upstream's route implementation or bypass the receipt/lease pipeline.
4. **Retain leases and unknown-outcome protection.** Upstream claims by changing status to running, without our `processing_started_at`, attempt count, completed continuation IDs or retry-safety context. A crash could strand the run or leave ambiguous external effects. Integrate with the existing pending worker and accepted/unknown-send markers, preserving completion identity and safe recovery. No second queue or scheduler.
5. **Handle the new parked-step kind explicitly.** Our `resumePendingExecution` at `engine.ts:331` deliberately accepts only a timed `wait` step. Reusing it unchanged for a parked Send Buttons/List step would reject the cursor. Distinguish timed waits and reply waits, retain the stable step identity and nested-branch continuation behavior, and fail safely if the step/option was removed.
6. **Preserve PMS context and eligibility.** Keep reservation/property context while replacing only inbound message fields; retain lifecycle/version checks, semantic preparation, selected WhatsApp number, property/workspace timezone rules and inactive-automation suppression. Exclude imported history from consuming reply waits.
7. **Validate and edit safely.** Add the option to the shared interactive config type, activation checks and existing builder. Preserve it when switching Buttons/List, strip control metadata from Meta payloads, and preserve existing actions. Existing automations should keep their current immediate-continuation behavior unless explicitly enabled.
8. **Bound expiry and handle edits.** Sweep expired waits in the existing worker with bounded batches, independently of due timed waits. Paused/deleted automations, deleted conversations/connections and changed steps need terminal explanations in existing logs. Deadline expiry must not become an unsolicited customer send.

## Safe implementation order and acceptance checks

1. Correct response classification/timezone and actor attribution, retaining the existing UI.
2. Add selected dashboard attention/queue/target features with matching Inbox filters; adapt memberships, multiple numbers and Coexistence provenance.
3. Add reply-wait using the existing engine, queue and webhook stages with transactional parking/claiming.

Before accepting implementation, verify: existing theme/filter and PMS paths retained; no unintended file deletions; all prior integration commits remain ancestors; per-account and per-number isolation; no guessed historical actor attribution; failed/automation messages do not improve human response metrics; history imports do not open live-window warnings or resume waits; one winner for simultaneous replies/menus; duplicate delivery and crash-after-acceptance do not resend; timed waits and nested branches still work; changed/paused/deleted definitions stop safely; reservations retain their context and timezone.

Run focused regression and disposable database concurrency tests, followed by full typecheck/test/build and DEV browser/provider checks. Source inspection alone is not evidence of production correctness.
