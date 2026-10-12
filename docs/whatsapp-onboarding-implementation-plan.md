# Unified WhatsApp onboarding and coexistence implementation plan

12 October 2026. Implements the fixes identified in [the current setup review](whatsapp-current-setup-review.md) and supersedes the initial production plan's implementation outline. This is the original planning baseline. See [implementation, validation and rollout status](whatsapp-runtime-hardening-release.md) for the subsequent fixes.

## Decision

Use one customer-facing setup and the existing Meta/Supabase architecture. Prioritize hosts keeping their WhatsApp Business mobile app; support full standard Cloud API registration for eligible numbers. The host's selection guides the flow; server-verified Meta state decides activation. Production readiness remains unproven until the fixes and release gates pass.

“Has a business WhatsApp account” is ambiguous. An active Business mobile app number, a Meta Business Portfolio and a Cloud API/Messaging account are different things. Distinguish them without asking the host to learn these technical terms.

## 1. Route every host to the right path

| Actual situation                                                       | Customer path                                                                          | Backend action                                                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Active WhatsApp Business app number, eligible for coexistence          | Keep using my Business app → Meta → confirm in the phone app → choose history sharing  | Validate token/assets, subscribe, verify coexistence, skip registration, initiate permitted synchronization.      |
| Unused number                                                          | Set up a number for CRM → Meta → create/select assets → SMS/voice verification         | Validate selected number, subscribe, register where needed, retain encrypted PIN, verify activation.              |
| Business assets already exist but number is unused                     | Standard setup reusing selected assets                                                 | Existing business assets do not imply coexistence. Complete registration normally.                                |
| Personal WhatsApp number                                               | Contextual explanation; another number or a reviewed conversion path                   | Never automatically delete/convert the personal account or promise personal-app coexistence.                      |
| Existing Cloud API number or provider                                  | Already connected to another service? → supported sharing/reconnect or assisted review | Check authorized owning assets, existing registration and provider/billing constraints. Preserve working service. |
| Existing coexistence number with another provider                      | Provider-specific access review                                                        | Do not assume that disconnecting makes the number available.                                                      |
| Device change temporarily offboards coexistence                        | Waiting for WhatsApp to reconnect                                                      | Pause pending sends; retain assets/history intent; resume on verified reconnection without new history requests.  |
| Ineligible number, incomplete verification or ambiguous selected phone | Clear action-needed state                                                              | Preserve safe progress; do not guess a number, register an app number or report connected.                        |

Meta's flow can create/select business assets, so a host without an existing Portfolio can start standard setup. Eligibility still depends on Meta. [Implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation), [Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider).

## 2. Meta contracts verified in depth

Official pages were read directly in the browser on 12 October: coexistence, implementation, v4, Tech Provider approval/onboarding, automatic reconnection and provider migration. Provider docs and public GitHub source were also inspected. This research establishes integration behavior, not our app's actual approval or live configuration.

### Launch, callbacks and tokens

- **Configuration selects v4.** Selecting products in Login for Business enables it; neither SDK version nor sessionInfoVersion proves the signup version. v2/v3 retire on **15 October 2026**. Use only needed products/assets, with Advanced Access to the two WhatsApp permissions. [Meta v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4), [provider approval](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers).
- Standard launch uses `extras: { setup: {} }`; Business-app launch adds `featureType: 'whatsapp_business_app_onboarding'` and `sessionInfoVersion: '3'`. Keep our strict origin validation and real SDK readiness checks. [Coexistence guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).
- Code callback and session event can arrive separately. The code lifetime is **30 seconds**. Exchange promptly; support both callback orders and expiry without indefinitely waiting for phone selection. Final-screen closure can count as success. Meta also documents `FINISH_ONLY_WABA`, coexistence completion and reported errors in CANCEL payloads. [Implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation).

### Standard registration

Tech Provider onboarding exchanges the code server-side, subscribes the customer account, registers the selected phone with a six-digit two-step PIN where necessary, and verifies messaging. SMS/voice ownership verification is distinct from API registration. Existing connected numbers require reconciliation rather than repeated registration. Guide the customer to add their Meta payment method; keep that separate from RZ subscription billing. [Meta onboarding steps](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider).

### Coexistence operation

The host confirms the connection in the Business app through Meta's presented code/QR process. Verify `is_on_biz_app` and `platform_type: CLOUD_API`; **never call /register for coexistence**. App outbound messages arrive as echoes; normal incoming messages/statuses remain on the messaging webhook. Required additional topics are account_update, history, smb_app_state_sync and smb_message_echoes.

Request contacts/history once within the documented 24-hour window. Request IDs establish acceptance, not consent or completed import. History can cover 180 days, with separate recent-media delivery; groups are excluded. Chunks can arrive out of order. API throughput is capped at 20 messages/second per coexistence number. Echoes and imported history do not open a customer service window. [Meta coexistence contract](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).

### Lifecycle and provider changes

Device-change reonboarding retains the existing assets/subscriptions, suspends API messaging and can restore the same connection automatically. It does not resync history. Distinguish ACCOUNT_OFFBOARDED/ACCOUNT_RECONNECTED from PARTNER_REMOVED and intentional fresh signup. [Meta reconnection](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/reconnect-offboarded-coexistence-clients/).

The current provider-migration page states that new-model numbers cannot move to a different owning account; disconnecting does not free them. Sharing the owning account remains possible. Do not apply older transfer recipes without verifying the model/path. [Meta migration guidance](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/support/migrating-phone-numbers-among-solution-partners-via-embedded-signup/).

## 3. Public implementation comparison

| Source reviewed                                                                                                                                                         | Evidence                                                                                                                                                         | Our design choice                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [WATI onboarding](https://support.wati.io/en/articles/11822421-how-to-connect-your-whatsapp-number-to-wati-via-whatsapp-coexistence-coex)                               | Coexistence/Cloud API choices, phone confirmation, history consent, background imports and connection status. Its payment instructions use WATI-managed billing. | Adopt clear choices/progress; retain our direct-Meta billing arrangement.                           |
| [Respond.io](https://respond.io/help/whatsapp/whatsapp-coexistence)                                                                                                     | Facebook-based app connection; echoes do not trigger automation or open service windows. Current guide says history/contact import is unsupported.               | Adopt echo isolation; implement Meta-supported history rather than copying that product limitation. |
| [360dialog setup](https://docs.360dialog.com/docs/hub/embedded-signup.md), [coexistence](https://docs.360dialog.com/docs/hub/embedded-signup/coexistence-onboarding.md) | Classifies unused, personal-app, Business-app and API numbers; guides phone confirmation and history consent.                                                    | Two primary choices with contextual personal/provider handling.                                     |
| [Chatwoot webhook source](https://github.com/chatwoot/chatwoot/blob/develop/app/services/whatsapp/webhook_setup_service.rb)                                             | Inspected subscription method lists messages/echoes plus optional calls, without history/contact topics there.                                                   | Do not assume an echo-capable implementation supplies the whole import contract.                    |
| [Meta sample launcher](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/main/app/components/Fbl4bLauncher.tsx)                             | Configuration-driven launch, code/session callbacks in either order, demo popup handling and broad origin matching.                                              | Adopt callback-order coverage; preserve our stricter origins, durable attempts and SDK guards.      |

Competitor docs are not interchangeable contracts. Respond.io's page contains conflicting edit/revoke statements; current Meta documents those events. WATI/Respond.io also publish account-reset/payment recovery recipes that do not establish a safe path for our direct Tech Provider/new account model. Use actual Meta eligibility/authorization results, not hardcoded waiting periods or automatic account deletion.

## 4. Architecture: extend the existing system

Keep canonical `whatsapp_config`, signup attempts/leases, encryption, the signed incoming webhook URL, contacts/conversations/messages, capability provider, broadcast recipients and the existing flow/automation engine. Preserve manual setup under Advanced. All database changes must be forward migrations after applied 78.

| Work                               | Existing owner                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Choice, callbacks, saved recovery  | Embedded-signup component/context, saved-signup hook and existing API actions              |
| Token/asset validation, activation | `src/lib/whatsapp/embedded-signup.ts` and signup RPCs                                      |
| Intake/import/reconciliation       | Current webhook, coexistence parser, receipt ledger and capture/process RPCs               |
| Send policy                        | Existing Meta messaging helpers, connection resolver and broadcast/flow/automation callers |
| Status and content                 | Config API/state, capability hook, settings UI, existing inbox records/renderers           |
| Scheduling                         | Existing WhatsApp import cron job and established pg_cron/pg_net/Vault pattern             |

Two narrow extensions are necessary:

1. **Internal TypeScript worker boundary.** Ordinary handlers and external sync calls cannot run inside SQL. Add a service-authenticated internal worker route, such as `/api/whatsapp/webhook/worker`, using the worker-auth/wake-up pattern already present for PMS. Expand the existing WhatsApp job to wake it; it dispatches existing SQL imports and TypeScript handlers. Use a dedicated WhatsApp credential. This adds no second incoming webhook, parallel event queue or independent scheduler.
2. **Shared per-number budget state.** A small service-only quota/lease store and atomic RPC coordinate instances. Keep quota locks separate from connection/import locks. Inbox defers with a clear quota response; broadcasts/automations use existing durable recipient/continuation state. This is not a second message queue/provider.

Evolve the existing receipt ledger to support ordinary, history, echo, lifecycle and unresolved signed events. If its name is generalized, migrate the same data compatibly and retain existing RPC compatibility during rollout; do not maintain competing ledgers.

## 5. Work packages and acceptance gates

### A. Security and release configuration — review issue 1

Map legitimate callers of the five exposed mutating maintenance functions; revoke inappropriate anon/authenticated execution while preserving internal/trigger use. Retire or correct conversation merging so distinct connection histories are not merged. Do not blanket-revoke every SECURITY DEFINER function.

Verify app approval/Advanced Access/live status, hosted v4 products, exact HTTPS domains, app-level topics and billing arrangement. Record staging/production identity, build/Node runtime, host durations and backup/restore process. Do not edit migrations 73–78 as undeployed files.

**Gate:** unauthorized mutations are denied; legitimate flows and recent signup restrictions remain intact; hosted configuration has independent evidence.

### B. Both onboarding paths and short-lived authorization

Make Business-app setup default. Handle FINISH, coexistence FINISH, WABA-only completion and final-screen closure explicitly. Grant/migration-only completions must yield a classified supported outcome or action-needed state, not an endless wait.

Exchange received codes promptly within existing signup API actions, validate app/type/scopes, then stage the token encrypted on the existing attempt. Bind/prove selected assets before activation. Do not persist raw codes or tokens in browser storage. Multiple authorized candidates require explicit selection; incomplete verification stays awaiting-phone setup. Continue through supported Meta setup using the existing authorized account, rather than creating duplicates.

Server verification may promote a standard launch to coexistence; it must never downgrade an app number into registration. Persist registration intent/PIN before external registration and reconcile uncertain outcomes. Preserve a working connection if replacement fails.

Meta exchange and local token persistence cannot be atomic. If exchange succeeded but no token was saved and no supported reconciliation exists, ask for fresh authorization while preserving the connection; do not promise recovery without Facebook for every failure.

**Gate:** both paths activate correctly; zero coexistence registration calls; both callback orders, 30-second expiry, ambiguous/missing phones and repeated callbacks have explicit safe results.

### C. Durable intake and fair processing — review issues 2, 6, 7

Persist supported signed deliveries before ACK, including ordinary messages/statuses. Bound payload/work sizes. Retain unresolved activation/lifecycle deliveries safely in the same private ledger without guessing tenants.

Use provider identities and processing-stage markers so replay repairs incomplete inbox/unread/automation work. Message insertion must not mark all later stages complete. Make canonical database writes transactional where appropriate; retain durable intent/acceptance barriers for external side effects. Unknown sends remain blocked from repetition.

Use short claims/transactions and bounded retries. Skip busy connections and continue other due work. Prioritize lifecycle/live traffic over historical imports. Connect the internal worker to the existing WhatsApp wake-up; after() is an opportunistic trigger, not the only recovery mechanism.

**Gate:** termination after ACK loses no captured work; replays duplicate no side effects; one busy tenant does not repeatedly block others; large histories do not starve current messages.

### D. Sync and lifecycle recovery — review issues 3, 8

Finalize connections with durable pending sync intent on existing state; the worker initiates missing requests before the deadline. Completed signup replay reports/reconciles pending work rather than silently returning success.

Replace ambiguous booleans with structured states for pending, requesting/unknown, accepted, receiving, sharing finished, imported, declined, definite rejection, deadline expiry and action needed. Store request IDs and safe error metadata. Never reset uncertain/accepted one-time requests into automatically retryable work.

Separate Meta progress from local backlog/failures. Do not invent an address-book completion signal, interpret no webhook as consent, or mark empty history complete after an arbitrary timer. Surface the backend's pending-sync response in the UI.

Device-change reconnection preserves the original sync epoch/intents. Explicit partner removal and fresh onboarding are different transitions. Deadline recovery must explain the actual supported process; generic reconnect is not a guarantee of fresh history. Retain ambiguous phone-less lifecycle events for reconciliation.

**Gate:** crash after finalization resumes; unknown requests never repeat; consent/empty-history cases are honest; old chunks/media cannot overwrite newer state; reconnection retains intent and resumes messaging safely.

### E. Shared send budget and offboarding — review issues 4, 5

Enforce atomic per-number allowance at the common Meta send boundary used by inbox, public API, broadcasts, flows, AI and automations. Cover every /messages path. Budget coexistence under its documented ceiling; standard numbers use separately verified capabilities.

Denied allowance defers locally before marking an external send uncertain. Avoid long sleeps inside user HTTP requests. Use existing durable broadcast/automation state for continuation and safe provider-rejection backoff.

Recheck connection/lifecycle generation at send checkpoints, including already-prepared broadcasts. Offboarding pauses pending work; an already-issued network request cannot be recalled. Resume only eligible unsent work, preserving accepted/unknown retry barriers.

**Gate:** mixed send sources on multiple instances share one number budget; offboarding pauses prepared work; quota deferral never causes duplicate or falsely attempted sends.

### F. Content, retention and simple UX — review issues 9, 10, 11

Preserve reply context, static locations, interactive fields and supported media metadata in canonical messages/renderers. Apply edit/revoke events to originals where supplied. Unsupported provider content gets an honest fallback. Echoes are business-origin: no inbound automation, unread inflation or service-window opening. History imports retain provenance.

Bound saved-attempt discovery and group/exclude expired non-recoverable attempts. Define retention for raw payloads, staged credentials and receipts while retaining required dedupe identities and uncertain-registration barriers. Do not indiscriminately purge expired intents.

Prepare the SDK and a short-lived attempt when the setup panel opens. Enable Continue with Facebook only when ready and invoke FB.login synchronously on that click. Preparation must not create attempts on every render.

After activation, show Connected, the number and Open inbox; display background history and Meta payment actions separately. Refresh only while actionable setup/sync is active through scoped realtime or bounded polling/backoff. Support reload, workspace switch, cancel and saved recovery on mobile/keyboard. Explain potentially competing app greeting/away responses when CRM automation is enabled; never disable host settings remotely.

**Gate:** ordinary hosts need no IDs/tokens/webhook copy-paste; unsupported account cases have next steps; supported payload details survive; expired attempts do not overwhelm the UI; progress stays fresh.

## 6. Minimal host journey

1. **Connect WhatsApp** — “Do you already use this number in the WhatsApp Business app?” Keep the app is recommended/default; otherwise offer standard registration. Personal/provider cases appear contextually.
2. **Continue with Facebook** — select/create business assets and verify/consent through Meta. Present a short app-specific notice about phone confirmation, history choice and linked devices.
3. **Connecting your number…** — automatic validated activation. If phone verification/selection remains, show exactly that next step.
4. **Connected → Open inbox** — background import status and separate payment guidance. Resume saved progress without repeating uncertain operations.

Eligibility is never guaranteed merely because a host has the app. Personal conversion/provider disconnection remain guided exceptions, not automatic fallback behavior.

## 7. Test matrix and deployment order

| Area            | Required coverage                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Security        | anon/authenticated denials; legitimate service/trigger operations; tenant/connection isolation                                         |
| New number      | New/existing business assets; SMS/voice; WABA-only/incomplete verification; already-connected number; PIN uncertainty                  |
| Coexistence     | App consent; eligible/ineligible number; WABA-only ambiguity; auto-promotion from standard; zero registration                          |
| SDK/auth        | Both callback orders; 30-second expiry; final-screen closure; CANCEL/error shapes; buffered SDK and popup blockers                     |
| Recovery        | Crash at every external/DB boundary; finalized-before-sync; consumed code/no saved token; replay/reload/workspace switch               |
| Webhooks        | Live/status/history/echo/lifecycle; duplicate/reordered deliveries; poison record; late media; edits/revokes; activation overlap       |
| Scale/lifecycle | Multiple instances/mixed sends; quota/backoff; prepared broadcast offboarding; busy-tenant fairness; large histories with live traffic |
| Sync/retention  | Sharing declined; no history/no completion signal; stable terminal states; failed imports; safe purge/replay horizon                   |
| UX/operations   | Minimal mobile/accessibility flow; current progress; billing action; worker alerts and safe support diagnostics                        |

Run focused checks and disposable **complete-schema** PostgreSQL tests, then realistic workload/failure tests in dedicated CRM staging. Previous 171 focused passes and empty-worker success are baseline evidence, not release approval. Proposed payload/latency thresholds must be calibrated against real expected workloads.

Complete real standard and coexistence onboarding with designated test numbers and the release Meta configuration. Validate customer → CRM, CRM replies/templates/statuses/media, app echoes, accepted/refused history, billing arrangement and lifecycle recovery. No fault tests against working customer/provider numbers.

Roll out compatible forward migrations before matching code. Sequence: security → compatible ledger/worker → signup/sync → shared send policy → content/retention/UX → staging gates → production canary. Preserve manual connections and the existing engine throughout. Rollback must retain captured work, valid connections and safe recovery state.

Observe oldest pending work, unresolved routing, failed receipts, worker last success, sync deadline risk, quota rejection and failure stage. Never put secrets or raw customer histories in logs/support summaries.

## 8. Execution prerequisites and scope

Confirmed preferences: Business-app-first plus standard registration, direct customer Meta billing, existing canonical infrastructure and manual/provider compatibility.

Release inputs still needed: staging/production identity, deployment URL/build/runtime, authenticated Meta approval/configuration evidence, safe test accounts/numbers and workload forecasts. These are live release dependencies; independent local fixes can proceed once implementation is requested.

No promise of universal provider migration or perpetual Meta compatibility. The deliverable is a complete supported lifecycle with regression coverage, explicit exceptions and detectable/recoverable operational failures.
