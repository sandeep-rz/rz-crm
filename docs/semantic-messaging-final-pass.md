# RGCRM semantic messaging — final implementation/audit pass

Date: 2026-10-08. Scope: manual Inbox templates, automation templates, and broadcasts. Existing uncommitted work was preserved. No live Meta messages or CRM/PMS database mutations were performed.

## 1. Issues found and fixed

- Broadcast delivery had no atomic per-recipient claim shared by the initial worker, browser batch endpoint, and resume worker. Overlapping callers could both send.
- Browser response handling independently wrote recipient outcomes and campaign status. A lost response could overwrite a server acceptance or ambiguous outcome.
- Broadcast resume's missing-phone update could erase the new unconfirmed-delivery guard. Accepted/unconfirmed rows are now excluded from planning and protected from that update.
- Browser batches silently omitted recipients with missing phones, leaving them pending. They now reach existing server validation.
- Automation Inbox content used raw resolved BODY values instead of the normalized values actually submitted to Meta. It now renders the assembled payload's BODY parameters.
- Manual template errors conflated preparation database failures with accepted-but-unsaved messages. Accepted failures now carry an explicit acceptance state and wamid; the Inbox retains a sent optimistic message with a warning. Preparation failures say no message was sent. Ambiguous semantic transport failures have a separate error code/message.
- Template conversation-preview failures were ignored. Manual and automation senders now report them as post-acceptance persistence failures.
- Semantic manual sends now explicitly reject a joined conversation contact whose account/id does not match the selected conversation.
- Semantic manual/automation sends use the validated destination without guessed phone variants. Existing non-template behavior remains.
- Removed phone values and raw provider/DB details from the touched send diagnostics; retained structural codes, trace IDs, and message IDs where useful.

## 2. Semantic persistence after this pass

| Meaning                 | Manual                                                             | Automation                        | Broadcast                         |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------- | --------------------------------- |
| Storage                 | Existing `messages` and `conversations`                            | Same                              | Same                              |
| Outbound representation | `sender_type=agent`, `content_type=template`, `status=sent`        | Same                              | Same                              |
| Provider identity       | `messages.message_id = wamid`                                      | Same                              | Same; also recipient wamid        |
| Display content         | Approved BODY rendered with actual normalized Meta text parameters | Same                              | Same for semantic templates       |
| Template identity       | Existing `template_name` field                                     | Same                              | Same                              |
| Conversation identity   | Account/contact/connection scoped                                  | Account/contact/connection scoped | Account/contact/connection scoped |
| Preview                 | Rendered content and existing timestamp conventions                | Same                              | Same                              |

BODY content is rendered for Inbox display; headers/buttons remain transport components under existing conventions. No unresolved canonical tokens or Meta positional placeholders are deliberately stored as rendered semantic BODY content. Existing legacy broadcasts retain their frozen parameter representation and rendering helpers.

The existing `findOrCreateConversationRow()`, `resolveAuditUserId()`, and template rendering helpers remain the persistence building blocks. The prior broadcast persistence helper is reused; no parallel message store was introduced.

## 3. Broadcast durability and failure boundaries

Immediately before Meta, one conditional database UPDATE claims a recipient using its recipient/broadcast/contact identity, eligible status, absent wamid, and absent unconfirmed guard. It uses existing `failed` + `error_message` fields with an explicit constant guard; there is no new status, column, table, queue, or migration.

| Outcome                                       | Durable behavior                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Validation/preparation fails                  | Safe failure; Meta is not called                                           |
| Claim fails/unavailable                       | Meta is not called                                                         |
| Typed Meta 4xx rejection, excluding 408       | Safe failure; intentional existing failed-recipient retry remains possible |
| Timeout, transport failure, 5xx, process loss | Guard remains; automatic/manual resume cannot reclaim the recipient        |
| Meta returns wamid                            | Save acceptance before Inbox persistence                                   |
| Inbox persistence fails                       | Retain accepted state/wamid; do not resend                                 |
| Acceptance write itself fails                 | Pre-send guard remains; do not resend                                      |
| Recipient already accepted/terminal           | Skip delivery; preserve terminal state                                     |

Browser batches no longer overwrite server-owned outcomes or campaign completion. Counters remain database-trigger owned; campaign status uses the existing recipient-derived finalizer. The existing campaign lock still protects resume requests, while the per-recipient claim protects delivery across entry points. Its stale-lock recovery cannot clear an unconfirmed recipient guard.

The guard intentionally counts as failed while an outcome is unconfirmed, including briefly during a request. It favors duplicate prevention: a crash after claiming but before contacting Meta can block an unsent recipient. There is no timeout-based automatic release or exactly-once claim.

## 4. Cross-consumer semantics and security

**VERIFIED BY TEST**

- CRM-only manual, automation, and contact broadcast sends work without unnecessary PMS resolution.
- Manual PMS templates require explicit reservation context; PMS automation supplies context; ordinary contact broadcasts reject reservation-required templates.
- Imported static configured templates work with `[]` mappings. Dynamic BODY, text HEADER, and URL placeholders still require mapping.
- Preparation/mapping/payload suites cover repeated variables, missing/unsupported/unknown variables, invalid mappings, text normalization, and unchanged URL parameters.
- Contact-phone equality/normalization, mismatches, foreign contacts/connections, rendered content, provider IDs, previews, and normal conversation storage are covered by focused tests.
- Retry containment, manual retry, PMS worker, pending worker, Wait continuations, and nested trigger/template validation remain green.

**VERIFIED BY CODE INSPECTION**

- Consumers continue through `prepareTemplateMessage()`, `validatePreparationMapping()`, the existing runtime resolver/catalog, and `buildMetaTemplateMessagePayload()`. Picker eligibility and authoritative send-time validation remain separate stages, rather than new competing semantic definitions.
- Template/connection ownership is checked by preparation. Runtime contact, reservation, property, and integration lookups are account scoped. Automation conversation resolution uses account/contact/connection, and broadcast delivery verifies the owning campaign and connection before recipient handling.
- Existing retry safety records unknown/accepted WhatsApp outcomes before local persistence on replayable automation paths. No retry architecture was modified.
- Existing automation `variable_mappings`/`variables` references reject or strip obsolete input; they are not alternate template execution branches. Interpolation remains used by other action types and was retained.
- No new resolved message values, guest names, phone numbers, emails, or provider payloads were added to diagnostics in the touched paths. This is not a repository-wide logging certification.

## 5. Exact files changed in this final pass

Paths below are repository relative. Several already contained uncommitted changes from preceding tasks; those changes were preserved.

Production:

- `src/app/api/whatsapp/broadcast/route.ts`
- `src/app/api/whatsapp/send/route.ts`
- `src/components/inbox/message-thread.tsx`
- `src/hooks/use-broadcast-sending.ts`
- `src/lib/automations/meta-send.ts`
- `src/lib/whatsapp/broadcast-core.ts`
- `src/lib/whatsapp/broadcast-delivery.ts` — new, shared recipient claim/failure handling
- `src/lib/whatsapp/broadcast-resume.ts`
- `src/lib/whatsapp/send-message.ts`

Tests:

- `src/app/api/whatsapp/send/route.semantic.test.ts`
- `src/hooks/use-broadcast-sending.test.tsx`
- `src/lib/automations/meta-send.test.ts`
- `src/lib/whatsapp/broadcast-delivery.pg.test.ts` — new, opt-in isolated PostgreSQL harness
- `src/lib/whatsapp/broadcast-resume.test.ts`
- `src/lib/whatsapp/broadcast-semantic.test.ts`
- `src/lib/whatsapp/manual-template-send.test.ts`

Report: `docs/semantic-messaging-final-pass.md`.

No migration added or changed. Earlier uncommitted contact/phone, broadcast persistence, and static-import changes remain in the working tree and were included in verification; their files are not falsely attributed to this final pass.

## 6. Dead code removed

Removed obsolete browser result/status/counter bookkeeping and its unused result interface. Removed semantic template phone-variant loops where inappropriate. No clearly dead additional automation execution branch was found; no broad cleanup was performed.

## 7. Test results

**VERIFIED BY TEST**

| Check                                                       | Exact result                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Final focused semantic/messaging/automation/template suites | **20 files passed; 453 tests passed**                                               |
| Isolated PostgreSQL broadcast claim tests                   | **1 file passed; 4 tests passed**                                                   |
| Typecheck (`tsc --noEmit`)                                  | **Passed**                                                                          |
| Scoped ESLint, 16 final-pass code/test files                | **0 errors; 2 existing Inbox warnings**                                             |
| Full automated suite                                        | **172 files passed, 1 failed, 5 skipped; 2,061 tests passed, 6 failed, 65 skipped** |
| Repository-wide ESLint                                      | **1 existing error; 26 warnings**                                                   |
| `git diff --check`                                          | **Passed**                                                                          |

Focused suites: broadcast-semantic, broadcast-resume, broadcast-core, use-broadcast-sending, automation meta-send, manual-template-send, send-message, manual send route and semantic route, validate-template-compatibility, send-template-fields, pms-worker, pending-worker, manual-retry, engine, semantic-template, template sync route, prepare-template-message, meta-template-payload, runtime-resolver.

The four PostgreSQL tests exercise actual conditional UPDATE predicates through two independent local connections: concurrent winner, abandoned unknown protection, definite-failure retry, and accepted/terminal/foreign-identity rejection. The harness uses only an isolated temporary database, not application credentials. The temporary server was stopped afterward.

Full-suite failures are confined to unchanged `src/i18n/messages.test.ts`: missing keys and placeholder/ICU parity in Korean, Portuguese, and Spanish catalogues. The repository lint error is the unchanged contacts-page synchronous state update in an effect. The two scoped warnings already exist in the Inbox component (unused `ScrollArea`, missing `tQuote` dependency). No final-pass functional test remains failing.

## 8. Remaining limits and deliberately unchanged areas

**NOT VERIFIED / REQUIRES LIVE TESTING**

- Real Meta delivery/webhooks, authenticated browser UX, production PostgREST/RLS behavior, and live PMS authorization were not exercised. Local SQL tests validate database claim concurrency, not the entire hosted stack.
- Opt-in live tests and the existing separate automation PostgreSQL harness were not run; they remain among the skipped tests.
- Accepted sends with failed local writes may be absent from Inbox. Duplicate prevention is implemented, not automatic local repair. If the acceptance write fails, the guard retains ambiguity rather than a durable wamid.
- Unconfirmed recipients require operator investigation; they are deliberately not released by time or resume. Campaign counters can reflect this conservative failure state.
- Historical batch calls without a persisted broadcast/recipient identity cannot use the new durable recipient claim. Normal dashboard and persisted worker/resume paths do. No public/MCP contract migration was attempted.
- Manual repeated user requests remain separate sends; no client-request idempotency/outbox was added. Automation guards remain limited to replayable PMS/Wait execution paths as designed.

Unchanged: canonical catalog, compiler, runtime/PMS resolvers, automation retry schema/engine, trigger/template compatibility architecture, WhatsApp config, MCP/public semantic migration, reservation audiences, Property Communication, queues, Redis, and generic outbox/exactly-once systems. Existing translation/lint failures were left outside this scope.
