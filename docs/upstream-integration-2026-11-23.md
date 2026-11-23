# Selective WACRM integration — 23 November 2026

## Local scope

Implemented the five agreed batches directly on local `main`, based on RZ `c0c98fa9826e1450d7b52083f27310834498fc35` and reviewed upstream `6dbeb5bf94d4cf01be351272d0d45b64b1a684d4`. Changes are uncommitted. Nothing was pushed, deployed or applied to a hosted database; no Meta/provider request was made.

Historical migrations, dependencies and lockfiles are unchanged. The prior RZ theme/filter, upstream integration, response-metric and PMS guest recovery commits remain ancestors of HEAD. No existing tracked file was deleted.

## Implemented batches

| Batch                        | Changes and RZ adaptations                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security                     | Block direct profile creation and privilege edits; require operational workspace membership for chat/flow Storage writes, including replacement paths. Validate conversation assignees against `account_members`, preserve members switched to another workspace, clear assignments when membership is removed, and display the saved assignment rather than assuming the requested assignment succeeded.                 |
| Contact/API integrity        | Find-or-create POST adds requested tags without deleting existing ones; outbound phone resolution preserves existing CRM names. Add bounded/escaped tag lookups and stable canonical selection, strict cursor/UUID handling, case-insensitive Bearer parsing, retryable API-key lookup failures, and credential-free webhook URLs. Existing tag automation dispatch remains.                                              |
| Engine correctness           | Conditional AI handoff assignment; claimed flow fallback transitions; atomic graph/metadata saves with RZ connection validation; bounded expired-flow selection and timestamp-fenced timeout updates; automatic-chain validation; save-before-activation failure handling; broadcast wizard/resume lease coordination; transactional, content-checked knowledge index replacement.                                        |
| Templates                    | Guard persistence of the captured unsubmitted draft, retain its author, and expose Meta acceptance for recovery if concurrent persistence loses. Support named imported header/body variables through catalog mapping, central runtime preparation, Meta parameter names, generic sending, snapshots and previews. RZ-authored templates remain positional and imported templates still require explicit catalog mapping. |
| Inbox/UI and persisted state | Mobile list width, desktop-only sidebar mounting, touch-only context toolbar, safe HTTP(S)/www links using existing theme tokens, and unsupported-inbound reasons persisted through the existing durable processor. Add contact paging recovery, non-destructive custom-value updates, selected-contact retention in bounded deal search, pipeline-stage reconciliation and stable flow node keys.                        |

Relevant upstream families: `4606bf49`/`e7113329`, `e74bfb78`/`0dada1a2`, `cebea5f1`/`3de12605`, `a482da9f`/`aad10904`, `021e82db`/`a52b5ae9`, `f4970d33`, `ee3aee72`, `49621ba3`, `89fecca9`/`dd0ff4c5`, `59d95200`, and `f118bbce`.

## Deliberate adaptations

- Do not import upstream's profile-based membership/removal implementation or account-only template uniqueness. RZ already has connection-aware template indexes from migration 046.
- Do not import upstream duplicate-tag retirement. Existing flows/automations can reference those IDs; imports choose a canonical match without deleting rows or moving their existing contact links.
- Broadcast recipient IDs, semantic preparation, frozen values, accepted/unknown markers and server-owned recipient outcomes remain canonical. A wizard interrupted by a lost/unverified lease stops sending and opens the saved broadcast; it does not overwrite recipient results or invite creation of a replacement campaign. Expired/superseded leases cannot renew.
- Pre-effect flow graph read failures propagate to the durable delivery stage for retry. They do not close a healthy run, fall through to AI or permanently mark the inbound reply consumed.
- Knowledge replacement uses a service-only transaction locking the parent document and checking the indexed content against its current content. This avoids partial deletion and stale-content index installation. Upstream's multi-request insert/delete replacement was not copied.
- Named Meta variables use optional `parameter_name` metadata alongside existing numeric mapping positions. Catalog identities, property/reservation context, runtime values, approval samples and frozen send snapshots retain their existing roles. Approval samples are never send-time fallback values.
- No new linkification dependency: message text remains React-escaped, and links use allowed web schemes and `noopener noreferrer nofollow`.

Production code for PMS integrations, automation engine/pending worker, Coexistence, durable receipt runtime, connection resolver, core send/acceptance guards, response metrics and global theme was preserved. The processor change is limited to retaining unsupported-message errors and documenting the flow retry contract; existing receipt/stage execution remains in place.

## Migration requirement

`supabase/migrations/93_upstream_security_engine_integrity.sql` must be applied after the existing RZ chain through 92 **before using/deploying the corresponding updated database-backed application paths**. It was generated with the Supabase CLI and numbered to follow this repository's existing sequence. It was applied only to the disposable local PostgreSQL fixture described below.

It adds permission/assignment guards, atomic flow graph persistence, bounded flow-timeout selection, broadcast delivery lease RPCs and service-only atomic knowledge replacement. No old migration was rewritten. Hosted migration state was not inspected or changed.

Optional Inbox tag editing, dashboard replacement, automation reply-wait, dependency upgrades, Docker changes and broad localization changes remain outside this integration.

## Validation

- Full application suite: **2,719 tests passed**, 187 skipped. The skipped set includes the 17 local SQL cases run separately below plus existing opt-in database/provider suites.
- Isolated PostgreSQL suite: **17 passed**. Covers profile guards, Storage role/workspace boundaries and path replacement, historical flow paths, cross-workspace assignees/removal, transactional graph replacement and rollback, connection ownership, expired-flow selection beyond a fresh-row cap, concurrent lease acquisition, expired/superseded leases, knowledge rollback/stale content/concurrent replacement, and internal RPC privileges.
- Typecheck, scoped ESLint, formatting and production build passed using Node 24.5.0. Build used dummy Supabase credentials; existing Next middleware/Edge deprecation warnings remain.
- Added application regressions include failed-save activation suppression, named semantic preparation, conditional draft persistence, unsupported inbound reasons, no incidental contact rename, lease refusal before a provider batch, and timeout snapshot fencing.
- The baseline exposed stale test fixtures from the earlier PMS recovery feature: the pending-worker tests expected the old claim RPC/result shape, and healthy-recipient semantic tests omitted `phone_normalized`. Those test fixtures were updated to the current contracts; production PMS/automation code was not changed to make them pass.
- Ancestry, protected production paths, historical migration preservation, no tracked deletions and `git diff --check` were checked.

### Local SQL reproduction and limits

The local test cluster uses only Unix socket `/tmp/rz-nov23-pg-socket`, port `55449`, database `rz_november_integrity_test`, user `postgres`. It has the database comment `RZ isolated November migration test`, checked before the test suite truncates fixture tables.

In a fresh isolated cluster, apply:

1. `src/lib/test-fixtures/upstream-integrity-schema.sql`, changing its database-comment target to this fixture database.
2. The actual migration 86.
3. `src/lib/test-fixtures/upstream-november-schema.sql`.
4. The actual migrations 81 and 93.
5. Create the assignment-notification trigger using the function in migration 93 and set the database comment above.
6. Run `RZ_NOVEMBER_PG_TEST=1 node node_modules/vitest/vitest.mjs run src/lib/upstream-november.pg.test.ts` with Node 24.

This is a focused PG14 fixture, not a full Supabase migration replay. Vector storage is represented as text in the fixture; the installed pgvector conversion remains a DEV validation item. Supabase CLI advisors could not parse the Unix-socket URL; explicit permission/RLS/transaction tests ran directly through PostgreSQL instead.

No hosted RLS/migration replay, DEV browser session, real Meta send or production end-to-end verification was performed. Apply migrations through the normal release workflow, then verify the affected browser/provider paths in DEV before production rollout.

## Follow-up: remaining notification and UI fixes

The additional authorized pieces of `4606bf49` and `a482da9f` are also implemented locally on `main`, without a commit, push or deployment. A live GitHub comparison confirmed upstream `main` still matched `6dbeb5b` at the follow-up review.

- Notification list queries, count queries and mark-read operations now explicitly scope both the selected workspace and the current recipient. A shared query hook ignores cancelled workspace responses, refreshes on subscription readiness, coalesces pending refreshes, and obtains authoritative counts instead of decrementing them for duplicate/partial realtime updates. Primary-key-only deletions trigger scoped refreshes. Existing Inbox navigation, notification copy and optimistic read UI remain.
- Inbox unread conversations use keyset pagination over unread IDs. Realtime reads, inserts and deletions received during loading overlay the snapshot; deleting or reading an earlier page does not shift later rows out of the result. Badges hide the old workspace's data immediately on workspace change or signout.
- Invitation responses are validated before rendering. Rate limits and malformed/network/server responses offer Retry; expired/used/missing invitations stay terminal. Late responses for a previous token are ignored. Explicit acceptance and the full reload that refreshes workspace auth after redemption remain unchanged.
- Audience estimates ignore superseded successes and failures while preserving RZ account-scoped audience resolution.
- Removing AI configuration clears stored, edited and displayed embeddings-key state, preventing it from carrying into a new configuration.

Validation for the combined local changes: **2,754 application tests passed**, 187 skipped; **35 new regressions passed** across five suites. Typecheck, scoped ESLint, formatting and the production build with dummy Supabase credentials passed. No new dependencies or migrations were added for this follow-up. The earlier 17 isolated SQL checks remain the database validation for migration 93; they were not rerun because this batch changes no schema or database functions. Historical migrations and protected PMS/Coexistence/send paths remain intact. Hosted/browser/provider verification remains outside the completed local checks.
