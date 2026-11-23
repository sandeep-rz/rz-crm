# WACRM upstream review — 22 November 2026

## Result and scope

Take the security, API data-preservation, engine correctness and small Inbox fixes selectively. Do not merge upstream main wholesale. Named template variables are useful but require integration with RZ's semantic sending contract.

- Reviewed RZ `main` at `c0c98fa9826e1450d7b52083f27310834498fc35`.
- Successfully fetched upstream `main`; fetched tip is `6dbeb5bf94d4cf01be351272d0d45b64b1a684d4`, dated 17 November 2026. A later redundant `ls-remote` failed DNS in the restricted shell; the successful fetch is the freshness evidence.
- Reviewed the 32 non-merge commits newly reachable since the previous reviewed upstream tip `34bce1a`, their changed-file inventory, relevant patches, and the corresponding current RZ implementations. Some newly reachable commits have author dates earlier than the previous review; author date alone is not an inclusion test.
- Existing theme/filter (`307996b`), security/AI/flows (`73a0ef9`), Inbox/webhook (`a240e21`) and response metrics (`6878c06`) commits remain ancestors of current HEAD.
- Working tree was clean before review. This report is the only file added. No application code, migration, commit, push, deployment, hosted database or provider operation was performed.
- Findings below are source-level. No exploit, browser reproduction, live database verification or test suite was run for this review. Upstream changes are candidates, not a claim that they are automatically correct for RZ.

## Recommended ports, in order

### 1. High: authorization and stale assignment protections

Sources: [4606bf49](https://github.com/ArnasDon/wacrm/commit/4606bf49), [e7113329](https://github.com/ArnasDon/wacrm/commit/e7113329).

Missing protections in the checked-in RZ chain:

- Migration 017 still permits direct self-profile INSERT; migration 034 guards privilege columns only on UPDATE. Upstream removes direct INSERT and extends the trigger. Actual privilege impact must be evaluated against RZ's membership-based helpers; this review does not claim a reproduced escalation.
- Chat/flow Storage write policies do not have upstream's agent-or-higher restriction. Migration 81 addressed SELECT, which does not replace write authorization. Adapt writes to RZ memberships and test viewer denial plus legitimate uploads, replacements and deletion.
- No `enforce_conversation_assignee_membership` guard was found. Upstream validates assignee membership, cleans stale assignments, and makes the UI use the actual persisted assignee instead of assuming its requested change succeeded.

Do not copy upstream migration 055 or its `remove_account_member` implementation: it derives membership from `profiles` and creates a replacement account. RZ uses `account_members`, cross-workspace membership and its own locked ownership/removal RPCs. Use a forward migration after the current RZ chain through 92; preserve invitation/workspace switching and use membership-aware assignee validation.

### 2. High: preserve contact data and harden public API inputs

Sources: [e74bfb78](https://github.com/ArnasDon/wacrm/commit/e74bfb78), [0dada1a2](https://github.com/ArnasDon/wacrm/commit/0dada1a2).

RZ `POST /api/v1/contacts` calls `setContactTags` even when find-or-create returns an existing contact. That replacement helper removes unrequested tags. Upstream changes this POST to additive tags; explicit replacement remains a separate operation. RZ's outbound phone resolver also updates an existing contact name from the send request; upstream removes that incidental rename.

Other useful pieces: strict cursor timestamp grammar before PostgREST interpolation, malformed UUID handling, case-insensitive Bearer parsing, a retryable 503 on API-key lookup failure, and rejecting webhook URLs containing credentials. The CSV tag resolver also gains bounded loading/insertion and conflict recovery; RZ's resolver currently loads all tags in one query and inserts missing tags without race recovery.

Preserve PMS canonical guest mapping, explicit international phone rules, CRM phone preservation, reservation reconciliation and automation contact recovery from migrations 89–92. Keep connection-aware conversation resolution, SSRF protection and existing tag automation dispatch. These are selective API fixes, not a replacement contact identity model.

### 3. High when AI/flows/broadcasts are used: remaining engine races

Sources: [cebea5f1](https://github.com/ArnasDon/wacrm/commit/cebea5f1), [3de12605](https://github.com/ArnasDon/wacrm/commit/3de12605).

Confirmed remaining differences:

- AI handoff builds its assignment from an earlier conversation read. A human assigned during summary generation can be overwritten. Upstream adds an assignment UPDATE conditional on `assigned_agent_id IS NULL`.
- Flow matched replies already have RZ's transition claim, but fallback reprompt/handoff/end still increments and acts without the equivalent claim. Upstream adds a compare-and-swap fallback transition.
- Flow metadata and graph persistence need an atomic operation; upstream adds `replace_flow_graph`. Preserve RZ graph authorization and cancellation behavior when adapting it.
- Flow timeout cron scans active rows and filters expiry in application code. Upstream selects bounded expired runs in SQL, avoiding row-cap starvation. It also adds graph chain-length validation and better handling of read failures for an already-owned run.
- Initial broadcast wizard sending and resume have different locking coverage. RZ resume has `delivery_locked_at`; its wizard hook lacks upstream's shared delivery lease. Adapt wizard/resume coordination while retaining frozen semantic payloads, per-recipient acceptance markers and unknown-outcome resend blocking. Upstream's lease is not evidence of exactly-once delivery.
- Knowledge re-ingest deletes old chunks before generating/inserting the replacement. Upstream inserts new chunks before deleting previously listed IDs, preserving old knowledge on insertion failure. Adapt with pagination and explicit concurrent-ingest handling; its simple snapshot/delete approach is not a full atomic replacement guarantee.

Retain durable webhook stages, number scoping, current send policy, PMS/property context and timezones, existing continuation leases and retry safeguards. Validate these changes with concurrent/replayed deliveries and disposable database tests before rollout.

### 4. Important: builder and persisted-state correctness

Sources: [a482da9f](https://github.com/ArnasDon/wacrm/commit/a482da9f), [aad10904](https://github.com/ArnasDon/wacrm/commit/aad10904).

Useful focused fixes include stopping flow activation when save fails, stable keys when adding nodes, pipeline stage reconciliation, clearing blank custom field values, and recovering contact pagination after deletion/filtering shrinks the result set. RZ flow editor still declares `save(): Promise<void>` and proceeds to activation after `await save()` even when save catches its error.

Port by component. This commit is not a reason to replace RZ's dashboard, reservation filters or response metrics. Preserve workspace-switch stale-response protection and existing theme tokens.

### 5. Important but partially covered: template lifecycle and catalog integrity

Sources: [021e82db](https://github.com/ArnasDon/wacrm/commit/021e82db), [a52b5ae9](https://github.com/ArnasDon/wacrm/commit/a52b5ae9).

RZ already scopes template/tag settings to the active account and already blocks resubmitting a template with a Meta ID. Its submit persistence helper, however, re-reads the row and then updates it without a `meta_template_id IS NULL` condition. Upstream's guarded draft save and duplicate handling are useful refinements.

Do not copy upstream's account-only template unique index: RZ explicitly resolves templates by account and WhatsApp connection and retains historical connections. Any deduplication/index migration must preserve those identities, references, semantic mappings, template snapshots and original author attribution. Review current RZ constraints before designing the migration.

### 6. Important: named Meta template variables

Source: [f4970d33](https://github.com/ArnasDon/wacrm/commit/f4970d33).

RZ's generic `template-send-builder.ts` still detects numeric variables only and its text parameter type has no `parameter_name`. Upstream handles named keys consistently in extraction, picker, preview and Meta parameters. This is useful for Meta-authored templates containing `{{customer_name}}`.

Adapt across RZ import/mapping/preparation, manual Inbox sends and broadcasts/automations. Do not replace semantic mappings with upstream's simpler ordered-value interface. Preserve positional templates and frozen approved payload behavior. Validate named headers/body, mixed or invalid formats and existing positional sends.

### 7. Recommended small Inbox fixes and optional convenience features

| Source                                                                                                                       | Behavior                                                        | RZ integration note                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ee3aee72](https://github.com/ArnasDon/wacrm/commit/ee3aee72)                                                                | Keep phone conversation list within viewport                    | Current RZ list wrapper lacks `min-w-0`; small CSS port.                                                                                                                                                  |
| [49621ba3](https://github.com/ArnasDon/wacrm/commit/49621ba3)                                                                | Preserve browser mouse/pen context menu; toolbar only for touch | RZ currently prevents every context menu; retain reply/reaction controls.                                                                                                                                 |
| [89fecca9](https://github.com/ArnasDon/wacrm/commit/89fecca9), [dd0ff4c5](https://github.com/ArnasDon/wacrm/commit/dd0ff4c5) | Clickable message URLs with safe link attributes                | Optional convenience; use safe schemes and preserve message rendering/snapshots. `c99e5741` is quote-style cleanup, not a separate functional fix.                                                        |
| [59d95200](https://github.com/ArnasDon/wacrm/commit/59d95200)                                                                | Avoid keeping hidden desktop contact panel mounted on mobile    | Useful query reduction; verify the initial mount too, since upstream starts `panelFits` true.                                                                                                             |
| [f118bbce](https://github.com/ArnasDon/wacrm/commit/f118bbce)                                                                | Retain Meta's reason for unsupported inbound messages           | Port into RZ `src/lib/whatsapp/webhook-processor.ts`, not by replacing upstream's webhook route. Preserve receipt/replay and Coexistence processing. Upstream migration 060 only changes column comments. |
| [0e335dab](https://github.com/ArnasDon/wacrm/commit/0e335dab)                                                                | Add/remove tags in Inbox contact sidebar                        | Optional useful feature; reuse RZ tag APIs, role gates and automation dispatch with account-switch request protection.                                                                                    |

## Defer or skip as a batch

- Dependency updates `98c0d6f1`, `39b9a973`, `a14d67dc`, `fd90e2ba`: review runtime compatibility and audit output independently. Do not overwrite the RZ manifest/lockfile wholesale.
- Build worker cap `e3e70f3e`: optional resource tuning, relevant if builds run out of memory; no observed RZ build failure was established here.
- Login placement `8714a56e`, shared translation/localization work `4d1b5784`, `4924599e`, `f0cd106c`, `da4ca03f`, Spanish/Portuguese catalogs and Docker support: lower priority or product/deployment choices; retain RZ strings and deployment configuration.
- The earlier optional dashboard attention/queue redesign and automation `wait_for_reply` still need the adaptations in `upstream-dashboard-reply-wait-review-2026-10-27.md`. Response metric corrections are already present in RZ (`6878c06`, migration 88); do not reapply them as though missing.

## Preservation and acceptance requirements for implementation

Use a new `codex/` integration branch based on the reviewed RZ HEAD. Port individual behaviors rather than taking whole upstream files. Keep historical migrations immutable and add forward RZ migrations where needed. All current PMS guest sync/reconciliation/recovery, Coexistence, semantic templates, durable delivery/retry, exact-ID Inbox acknowledgements, theme, reservation filters, workspace memberships and response metrics must remain.

Before accepting an implementation: check ancestry and deletions; test the changed contracts and account/connection isolation; run focused concurrency/database scenarios where relevant, then typecheck, lint, application tests and build. Perform DEV browser/provider verification separately. This source review does not establish hosted migration state or authorize production writes.
