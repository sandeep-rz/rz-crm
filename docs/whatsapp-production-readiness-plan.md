# WhatsApp Embedded Signup and coexistence production plan

Date: 11 October 2026. Repository baseline: `73c53f5`.

Detailed implementation plan after deeper Meta/provider/source research: [Unified onboarding and coexistence implementation plan](whatsapp-onboarding-implementation-plan.md), 12 October 2026. It supersedes this initial implementation outline and maps fixes for all eleven reviewed issues to acceptance gates.

Latest review, 12 October 2026: see [current setup issues and limitations](whatsapp-current-setup-review.md). Add a first security gate for exposed legacy mutating RPCs, then address ordinary webhook durability, the crash-after-finalization sync gap, lifecycle overlap, shared send budgets and fair imports before rollout. Earlier evidence below is a planning-session snapshot; the management verification and current review supersede its access/deployment unknowns.

## Decision

Keep the existing Meta Tech Provider / Embedded Signup architecture and harden it in place. The implementation follows the core coexistence contract, but **production readiness and scalability are not yet established**. This document is a researched implementation plan with an initial evidence baseline, not a completed production audit or release approval.

The goal is reliable onboarding for an existing WhatsApp Business app number, with new Cloud API number onboarding also supported; a small customer-facing flow; durable recovery; and measurable behavior across multiple application instances. The user confirmed that existing Business app users are the priority, with new-number setup also supported.

No application code, migrations, remote configuration, connections or messages were changed during planning. Only this plan was added. The existing deletion of `src.zip` was left untouched.

## Research basis

Use official Meta documentation as the integration contract. Use public source code to compare implementations and issue reports to select regression scenarios. Provider blogs help discover recent changes; validate their technical claims against Meta before implementing them. The research is targeted coverage of relevant sources, not an exhaustive review of the internet.

Direct web fetches of Meta pages returned HTTP 429. The official coexistence and v4 pages were successfully read through the browser instead.

| Source | Role in this plan |
| --- | --- |
| [Meta coexistence guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) | Launch parameters, registration exclusion, one-time synchronization, webhook fields, limits and customer-visible restrictions. |
| [Meta v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4) | Configuration-selected v4, phone-number-first rollout and product permissions. |
| [Meta Tech Provider reference app](https://github.com/fbsamples/business-messaging-sample-tech-provider-app) | Official reference lifecycle and environment/configuration separation. Its demo infrastructure is not a requirement to replace our stack. |
| [Chatwoot webhook setup source](https://github.com/chatwoot/chatwoot/blob/develop/app/services/whatsapp/webhook_setup_service.rb) | Implementation comparison: inspected subscription list includes messages and echoes, plus optional calls; this does not establish complete history/contact synchronization support. |
| [Chatwoot echo reply issue](https://github.com/chatwoot/chatwoot/issues/15325) | Reported quoted-reply problems inform a payload-preservation test. The issue includes a possible-fix comment; its reported root cause is not treated as a confirmed current Meta limitation. |
| [360dialog migration article](https://360dialog.com/blog/embedded-signup-versions-migration/) | Discovery of version-transition and phone-number-first considerations; official pages were checked independently. |
| [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) and [Cron](https://supabase.com/docs/guides/cron) | Database authorization and worker-operation verification. |

Meta's current pages confirm that v2/v3 retire on **15 October 2026**, and that product selection in a new Login for Business configuration enables v4. SDK Graph version and `sessionInfoVersion` do not prove the configured Embedded Signup version. Coexistence uses `whatsapp_business_app_onboarding`, skips phone registration, requests contacts/history once within the documented 24-hour window, and requires additional webhook fields. Its documented sending ceiling is 20 messages/second per number. These are immediate configuration and release-test priorities, not grounds for blindly changing API versions. [Meta v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4), [Meta coexistence](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).

## Current evidence

| Area | Verified in this planning session | Remaining evidence |
| --- | --- | --- |
| Architecture | This checkout is the WACRM-derived CRM, using npm and Next.js 16.3.5. The supplied stays/PMS monorepo commands do not match its package.json. | Actual production host, build revision, Node runtime and timeout settings. |
| Launch | `embedded-signup-context.ts` implements the documented coexistence extras and separate standard launch; public App/Config IDs are shared across modes. | Hosted configuration products, v4 selection, app approval, advanced permissions, domains and customer eligibility. |
| Activation | Backend verifies asset access, checks Business app/Cloud API state, and skips registration for confirmed coexistence. Saved attempts and guarded recovery already exist. | Real issued tokens and callback orderings; external-success/database-failure recovery. |
| API versions | Browser SDK is v26.0; signup Graph helper defaults to v21.0. | Compatibility of every used endpoint/field with the supported server version; coordinated version policy. |
| Webhook capture | Signature validation precedes parsing; coexistence events are persisted before ACK. Durable import ledger, bounded batches, retry state and cron migration exist. | Capture behavior during activation/reconnect; missing mapping; full-schema constraints; large payload latency. |
| Ordinary inbound messages | Existing webhook ACKs and then handles normal messages/statuses through `after()` within a 60-second route. | Timeout/crash recovery after ACK. `after()` has a duration limit and does not establish durable delivery by itself. |
| Synchronization | One-time request intents are saved before Meta calls; ambiguous outcomes are not blindly resent. | Accepted-but-no-webhook behavior, definitive rejection handling, completion with out-of-order chunks and exhausted receipts. |
| Database deployment | Zero-row service API reads succeeded for signup attempts, coexistence events, config coexistence metadata/timestamps, message provenance and contact app-state columns. Anonymous ledger reads were denied with PostgreSQL 42501. | Exact migration history, function definitions/grants, authenticated tenant isolation, active cron schedule and execution history. |
| Scale | Import migration processes up to 25 receipt batches of 100 records per call and uses row locking. Current application rate limiter is process-local; its source explicitly documents horizontal-scale limitations. | Shared per-number send budget across inbox/broadcast/automation; database lock contention, fair backlog draining and sustained capacity. |
| UI | Two connection choices, Advanced manual setup, saved recovery and import status already exist. Current default is `cloud_api`; popup preparation and launch are separate clicks. | Fewer repeated controls, clear first-run defaults, recovery UX, mobile behavior and understandable readiness status. |
| Documentation | Older signup document says coexistence is unsupported; newer coexistence document describes implemented support. | One consistent operator guide with current deployment evidence. |

The configured CRM Supabase project is `ideibnrtszjdrxsusnwc`. Management access was unavailable during the initial planning session and was verified on 12 October through the newly connected CRM account. The original API probes read zero customer rows and used existing local credentials without printing them. Management verification and the current review add migration, function and cron evidence. Production identity still needs confirmation.

## Work sequence and deliverables

### 1. Complete the deployment and Meta audit

- Identify the CRM production and staging projects, deployment URL/build/runtime, Meta app owner and expected customer billing model.
- Inspect App Review, Tech Provider status, required advanced permissions, published/live status, Login for Business products and v4 configuration, exact allowed domains, and all necessary app-level webhook fields. Distinguish these from subscribing an individual Messaging account/WABA.
- Read the relevant Meta implementation, token onboarding, lifecycle, account changes, webhook references, migration/share and error documentation. Record unresolved provider eligibility and transfer questions rather than prescribing disconnection.
- Inspect migrations 73–78 and deployed equivalents, RPC signatures and grants, RLS, tenant constraints, indexes, extension availability, cron job/run history and advisors. Keep credential-bearing rows out of audit output.
- Confirm backup/recovery and migration ordering. Do not edit migrations presumed unapplied from an old note: determine current deployment state first.

Deliverable: comparison matrix with **implemented / deployed / live verified / missing / not tested**, severity, exact source and smallest corrective action for each item.

### 2. Make onboarding and recovery dependable

- Preserve the canonical `whatsapp_config`, encryption, authorization, signup attempts and capability provider. Fix each verified gap inside these paths.
- Exercise standard FINISH, coexistence FINISH, WABA-only coexistence completion, phone-number-first automatic coexistence, absent/unverified phone, contradictory mode hints, callback-before-event and event-before-callback.
- Keep popup launch synchronous from an enabled user click after preparation; never move token/session network work ahead of `FB.login()` inside that click.
- Prove no phone registration call for coexistence, cross-tenant takeover, OAuth replay or destructive reconnect. Preserve a working connection if replacement setup fails.
- Separate request acceptance, data receipt, import backlog and actual completion. Verify completion does not appear while earlier captured chunks remain pending. Decide how to represent Meta progress when a chunk has not yet arrived.
- Test crashes before/after each external call and database write. Reconcile ambiguous outcomes without automatic repeated registration, one-time sync requests or duplicate messaging.
- Establish a supported server Graph API policy after endpoint compatibility tests. Centralize configuration only if it reduces actual drift; upgrade separately from frontend SDK changes.

Deliverable: scoped implementation, meaningful regression tests and safe support diagnostics.

### 3. Prove webhook durability and scale

- Trace signed delivery through persistence, ACK, processing and final canonical writes for coexistence **and ordinary messages/statuses**. Close verified post-ACK data-loss gaps using the established processing infrastructure.
- Test delivery during activation before final connection metadata exists, ambiguous lifecycle mapping, reconnect epochs, duplicated requests, reordered chunks, concurrent live/history messages, late media and poison records.
- Measure receipt and connection lock behavior across workers. Prove a busy number cannot prevent other tenants' backlogs from draining. Keep bounded transactions and existing scheduling infrastructure.
- Audit all send entry points together. Enforce a shared per-number budget across instances and send sources, with coexistence limits, safe provider backoff and preservation of ambiguous-send blocking. Process-local request limits are insufficient evidence of this behavior.
- Define retention for completed receipts and expired signup data while retaining identities needed for replay protection and incident recovery. Inspect existing cleanup before adding one.
- Add operator visibility for oldest pending receipt, backlog/failed counts, worker last success, signup failure stage, synchronization deadline and rate rejection. Do not emit tokens, codes, PINs, raw history or contact lists.
- Benchmark the actual database tier with realistic history sizes and multi-tenant overlap. Tune measured bottlenecks; avoid introducing a second webhook endpoint, connection store or automation engine.

Deliverable: load/failure report with measured latency, throughput, lock waits, maximum backlog age, fairness and capacity headroom.

### 4. Simplify the customer experience

Proposed flow:

1. **Connect WhatsApp** — one short explanation and two plain choices: “Use my WhatsApp Business app” and “Use a new number.” Confirm the appropriate default; handle existing API-provider cases with contextual guidance.
2. **Continue with Facebook** — SDK/session preparation happens visibly before this enabled click. Meta owns consent and phone verification.
3. **Connecting…** — automatically exchange, validate, subscribe and request permitted synchronization. Show meaningful progress and keep recovery available after refresh.
4. **Connected** — display the number, a primary “Open inbox” action, and optional history progress. Present payment action when needed without claiming billing verification.

Keep technical identifiers, token input, webhook instructions and developer details under Advanced. Replace the long upfront coexistence paragraph with a short essential notice and expandable detail. Explain app/linked-device changes before consent, the need to keep the app open during sync, and history consent without promising full feature parity.

Show one relevant recovery action: reopen popup, resume saved setup, check Meta payment settings, or reconnect. Avoid a generic “try again” that can replay uncertain operations. Preserve manual setup as a supported compatibility route.

Deliverable: implemented desktop/mobile flow with plain copy, accessible status changes and tested refresh/cancel/recovery behavior.

### 5. Validate and roll out

- First use a disposable **complete schema**, then a dedicated CRM staging environment. Existing SQL tests can truncate fixture tables; never point them at application databases.
- Run focused unit/route/UI tests, full-schema PostgreSQL tests, typecheck, affected lint, build and real browser checks. Track unrelated failures explicitly.
- With designated test accounts/numbers, complete one new-number flow and one existing Business app coexistence flow using the exact release Meta configuration.
- Verify controlled incoming/reply/template/status/media events, app echoes, permitted history/contact sync, declined history, saved recovery, offboarding/reconnect and multi-workspace isolation. Do not disturb existing customer/provider connections for fault tests.
- Apply any necessary forward migrations through the existing release workflow; verify grants and active workers before enabling the matching feature. Keep a canary and a rollback that preserves connections and recoverable data.
- Reconcile the two existing guides into one maintained source of operator truth and record the tested build/configuration/schema versions.

Deliverable: explicit **READY / NOT READY** release report with measured acceptance results, remaining limitations and rollback steps.

## Proposed acceptance criteria

These are release targets to validate against realistic workloads; no performance result is claimed here.

- Both onboarding modes complete on the production-equivalent configuration and supported desktop/mobile browsers.
- A fresh user needs no Meta IDs, tokens, webhook copy/paste or developer knowledge.
- Coexistence makes zero registration calls; repeated callbacks and simultaneous recovery create one logical activation.
- Tenant isolation passes for normal and privileged paths; private ledger access is denied to unauthorized clients.
- Every acknowledged supported event survives process termination and eventually reaches its canonical record or a visible recoverable failure.
- Replayed/imported history creates no duplicate messages, unread inflation, inbound automation execution or false customer service window.
- Initial load scenario: ten simultaneous onboarding/sync sessions, including a 100,000-message history fixture, mixed with sustained live traffic and concurrent send sources. Adjust upward to the real business forecast.
- Initial ACK target: p95 under one second for ordinary events and under five seconds for the largest supported history payload; sustained backlog drains with margin before Meta's synchronization deadline. Record max payload, hardware and measured results.
- Send sources share the permitted number budget across instances; ambiguous sends remain retry-blocked.
- Worker exhaustion, token/access loss and incomplete synchronization surface to operators with a safe customer action.
- Production deployment, Meta approval/configuration, billing arrangement and real E2E evidence are recorded separately from automated checks.

## Validation run during planning

- Bundled Node **24.19.0**: **10 focused files / 171 tests passed**, covering signup backend, SDK/UI, coexistence parsing/sync, discovery and webhook routes.
- TypeScript `tsc --noEmit`: passed using that runtime.
- Initial shell Node **20.17.0** run failed to initialize four jsdom UI workers with `ERR_REQUIRE_ESM`. Re-running on Node 24 resolved this test-runner issue without code changes. Pin and verify the intended development/CI/production runtime during implementation.
- PostgreSQL coexistence suite: **28 tests skipped** because the disposable database flag/environment was not enabled. No full-schema SQL or live Meta test was performed.
- Zero-row CRM API probes: five expected table/column selections returned HTTP 200; anonymous reads of both private ledgers returned HTTP 401 / SQLSTATE 42501.
- Full suite, production build, database advisors, authenticated RLS, RPC grants, cron execution, load tests, Meta dashboard, live signup and billing: **NOT TESTED** in this planning session.

## Inputs still needed

Confirm whether the configured CRM project is production, identify a staging project and release URL, and designate safe test numbers/accounts for later live validation. Management access was verified on 12 October 2026. The first-run path is confirmed: prioritize existing WhatsApp Business app plus CRM, retaining new-number setup. Work that does not depend on the remaining inputs can continue.

## Management-access verification — 12 October 2026

The newly connected `crm` account can access `ideibnrtszjdrxsusnwc`; Supabase reports the project as ACTIVE_HEALTHY. Read-only catalog queries confirmed:

- Migration history includes all six WhatsApp onboarding/coexistence migrations 73–78. This verifies recorded application, not byte-for-byte parity of every deployed definition.
- RLS is enabled on `whatsapp_config`, `whatsapp_signup_attempts` and `whatsapp_coexistence_events`. Both private ledgers deny SELECT to anon and authenticated roles. Config has SELECT grants, so tenant isolation still requires policy and runtime checks.
- All 14 inspected signup/coexistence functions deny execution to anon and authenticated. Thirteen allow service_role execution; `claim_whatsapp_signup_lease` does not, consistent with a protected internal helper pending definition review. Each inspected function has an explicit `search_path=public, pg_temp`.
- The `whatsapp-coexistence-import` cron job is active on a once-per-minute schedule. Its last 24-hour execution summary reports 1,440 succeeded runs and no other status rows. This confirms scheduler execution, not successful imports under traffic or an empty failed-event backlog.

No database writes, migrations or provider operations were performed. The earlier management-access limitation is resolved; Meta dashboard/live validation, full-schema regression tests, advisors, workload measurements and deeper definition/policy review remain outstanding.

“Fixed once” means closing the integration gaps and retaining regression tests, observability and a repeatable release gate. Meta can change eligibility, versions and account behavior; a durable setup must also make those future changes detectable and manageable.
