# WACRM upstream review — 27 October 2026

## Verdict and scope

Selectively port the missing fixes below. A wholesale merge would overlap RZ PMS, semantic templates, retry safety, Coexistence, workspace memberships and UI customizations.

- RZ branch: `main`, HEAD `b32ed18ad9c231f98866e743f314b1b4d08dd1a3`.
- Upstream main: `34bce1a8abf56281505d90bac165123b6ab7d51a`, independently checked through the live GitHub commits API. The local upstream objects match that SHA. Latest upstream commit: 17 October 2026 in India/UTC.
- Git divergence: 77 RZ-only / 131 upstream-only commits, including merges and previously ported changes under different hashes. These counts are not counts of missing fixes.
- Reviewed upstream non-merge commit inventory, relevant patches and current RZ implementations. The earlier October 13 review provided context; its recommendations were rechecked where used below.
- Existing theme/filter edits were preserved. No application code, migrations, refs or deployed services changed during this review. This report is the only new artifact.
- Findings are source-level unless explicitly identified as reproduced. No live database, Meta, CDN or concurrency test was run.

## Recommended ports

### 1. High: media proxy response protection

Upstream: [bd4025b](https://github.com/ArnasDon/wacrm/commit/bd4025b), plus [b1504c3](https://github.com/ArnasDon/wacrm/commit/b1504c3).

RZ `src/app/api/whatsapp/media/[mediaId]/route.ts:65` returns Meta's content type with `public, max-age=86400`, without attachment disposition or an enforced sandbox CSP. The global CSP is report-only. Opening customer-sent HTML/SVG/XML on the CRM origin presents an active-content risk; public caching is also inappropriate for this authenticated response. No browser exploit was attempted.

Port the safe inline MIME allowlist, attachment fallback, nosniff, sandbox CSP and private cache header. Include the follow-up preserving document filenames on download. Preserve the RZ connection resolver, explicit `whatsapp_config_id`, workspace checks and historical media handling.

### 2. High: strict contact phone matching

Upstream: [bdbd59d](https://github.com/ArnasDon/wacrm/commit/bdbd59d).

RZ `src/lib/whatsapp/phone-utils.ts:25` equates numbers sharing their final eight digits. `src/lib/contacts/dedupe.ts` uses suffix queries and this matcher. A direct execution of the actual TypeScript helper confirmed that `+91 98765 43210` and `+44 98765 43210` compare equal.

Port exact normalized matching plus the narrow trunk-zero exception and exact-candidate preference. Test different country codes, formatting, legitimate trunk variants and existing PMS contact linking. This is a data-association fix; do not run a global contact merge or rewrite historical associations automatically. The same upstream commit also contains useful UUID input validation, phone-search and quick-reply corrections that can be reviewed as separate ports.

### 3. High when AI auto-reply is enabled: recheck human takeover before sending

Upstream: [55e092f](https://github.com/ArnasDon/wacrm/commit/55e092f).

RZ checks conversation eligibility before generation, but `claim_ai_reply_slot` in migration 029 only checks the reply-count cap. It does not recheck `ai_autoreply_disabled` or `assigned_agent_id`. The TypeScript send path also lacks upstream's latest-inbound check. A human takeover or newer message during generation can leave a stale generated reply eligible to send.

Adapt the atomic eligibility predicates and latest-inbound check, retaining service-only RPC permissions and RZ send policy. Use a forward RZ migration rather than copying upstream migration numbers. Upstream's other knowledge-indexing, keyword-search and usage-pagination improvements are useful follow-ups, not prerequisites for this focused port.

### 4. High when flows are enabled: stop paused runs and claim reply transitions

Upstream: [dff99c9](https://github.com/ArnasDon/wacrm/commit/dff99c9).

RZ `src/lib/flows/engine.ts:941` loads an existing active run and immediately handles its reply without reloading the flow's current status. The activation endpoint changes flow status without cancelling existing runs. Thus changing a flow to draft/archived does not itself stop this path.

Port active-flow validation, current-node validation, reply-time timeout checks, atomic reply transition claiming, active-save validation and automatic-cycle detection. Retain RZ connection context, permanent deletion guards and webhook delivery-stage safety. Database changes require adapted forward migrations and concurrency regression tests.

### 5. Important: newest-first paging for long Inbox threads

Upstream: [0fd470b](https://github.com/ArnasDon/wacrm/commit/0fd470b).

RZ `src/components/inbox/message-thread.tsx:312` fetches messages ascending without pagination. Once a thread exceeds the server row cap, the response can contain its oldest messages and omit its newest ones. This is especially relevant after Coexistence imports. The current load callback replaces message state, so failed/local bubbles also need careful reconciliation.

Port the newest-200 initial page, Load older messages, scroll preservation and targeted optimistic-message reconciliation. Preserve RZ acknowledgement/retry updates, media placeholders, deletion behavior and message deduplication.

### 6. Important: broadcast per-recipient parameter transport

Upstream: parameter portion of [8125256](https://github.com/ArnasDon/wacrm/commit/8125256).

RZ's latest `create_broadcast_with_recipients` definition remains migration 041 with `p_template_params JSONB[]`, while `broadcast-core.ts:247` supplies nested parameter arrays. Upstream replaces this with one JSONB array and pairs recipients/parameter arrays by ordinality, addressing PostgREST flattening. This review confirmed the signature and caller but did not reproduce it against deployed PostgREST.

Adapt the RPC transport/validation in a forward migration and test variable-length per-recipient values through an actual disposable PostgREST endpoint. Preserve RZ frozen semantic payloads, atomic campaign creation, acceptance markers and unknown-delivery resend blocks. RZ migration 79 already implements conditional status transitions, so the entire upstream status rewrite is unnecessary.

### 7. Important: rate limits before Meta calls and manual automation triggers

Upstream: [feb50df](https://github.com/ArnasDon/wacrm/commit/feb50df).

The reviewed RZ WhatsApp configuration, template lifecycle, media proxy and automation engine routes do not call the shared rate limiter. The repository has a reusable limiter already. Upstream adds per-user budgets for administrative Meta calls, media downloads and automation triggering.

Adapt the shared budgets, return 429 before external calls, and test legitimate Inbox/media bursts. Do not confuse HTTP budgets with RZ's existing per-number WhatsApp send pacing; both serve different purposes.

### 8. Important but selective: stable automation resume positions

Upstream: stable parked-step portion of [bf39722](https://github.com/ArnasDon/wacrm/commit/bf39722).

RZ delayed continuations still store parent/branch/next numeric position. Editing or reordering steps while a run waits can make that cursor refer to different work. Upstream persists the parked step identity and resolves its current position on resume, refusing when the step was removed.

Port this part into the existing RZ continuation mechanism. RZ already has inactive-automation suppression, leased claiming, safe retries, nested suspension propagation and timezone policy. Replacing those wholesale would lose stronger/custom behavior. Preserve property timezone for PMS and workspace/user timezone for general automations.

### 9. Adapt separately: account identity and ownership races

Upstream: [617d211](https://github.com/ArnasDon/wacrm/commit/617d211).

RZ has an account-wide admin UPDATE policy, and no matching identity-column protection trigger was found. The current migration 043 ownership transfer also reads caller/target membership roles without explicit pre-read row locking. Upstream's direct owner/id/created_at update protection and deterministic locking deserve adaptation to `account_members`.

Do not copy upstream's profile-based membership implementation. In particular, RZ invitation redemption already adds a membership without deleting the previous account, so upstream's invitation-deletion correction is already superseded here. Validate transfer/removal concurrently in a disposable database before claiming correctness.

## Already covered or avoid replacing

- Private/no-store page responses: present in `next.config.ts`.
- Large broadcast audience/exclusion/resume pagination: adapted in RZ `c43781a`; preserve its explicit workspace and retry guards.
- Scoped Storage SELECT policies: forward migration 81 exists; deployed application was not checked.
- Internal privileged-function revocation: RZ migration 79 already restricts these and disables legacy global merge helpers.
- Nested automation wait propagation and failed-branch handling: present in the current engine.
- Forward-only, account/connection-scoped message and broadcast status handling: present in migration 79.
- Automation template headers: RZ sends a prepared semantic payload through the existing builder; do not replace this with upstream's simpler template-row interface.
- Optional `wait_for_reply`, OpenAI-compatible provider and full dashboard redesign: features, not necessary security ports. They need separate product decisions and RZ-specific adaptation.

## Optional improvements after correctness work

- [1ba1221](https://github.com/ArnasDon/wacrm/commit/1ba1221) and [a20253a](https://github.com/ArnasDon/wacrm/commit/a20253a): action-focused dashboard, reply targets, real-reply metrics and separate human/AI response measurements. Useful, but a larger UI/schema change.
- [0a68832](https://github.com/ArnasDon/wacrm/commit/0a68832): do not reuse an AI key after switching providers. RZ currently allows OpenAI/Anthropic only, so the arbitrary compatible-endpoint risk from upstream does not apply, but provider-matched key reuse is still sensible.
- Consolidated runtime/dependency maintenance after deployment Node version is confirmed. A newer upstream version alone is not evidence of a missing application fix.

Recommended sequence: media protection and phone matching first; AI takeover and flow execution guards next; then thread paging, rate limits and adapted database fixes. No upstream code was applied by this review.
