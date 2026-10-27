# Selective upstream fixes, AI/Agents and Flows integration

Implemented locally on `codex/upstream-fixes-ai-flows`, starting from RZ `307996b` (the committed theme and reservation-filter fixes). Upstream `main` was verified through GitHub as `34bce1a8abf56281505d90bac165123b6ab7d51a` on 27 October 2026. Changes were ported by subsystem, preserving RZ modifications rather than merging upstream wholesale.

## Included upstream changes

| Source                                              | Applied behavior and RZ adaptation                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bd4025b`, `b1504c3`                                | Safe inline media MIME allowlist; attachment fallback; enforced sandbox CSP/nosniff; private cache headers; document-click filename preservation. Existing account/connection resolver retained.                                                                                                                                                                  |
| `bdbd59d`                                           | Exact normalized phone matching and narrow trunk-zero matching; exact-candidate preference; digit-aware contact search; UUID filter validation; merged quick-reply validation and missing-row responses; trusted proxy IP selection. Existing workspace/contact authorization retained.                                                                           |
| `76538fd`, `d634c03`                                | OpenAI-compatible provider in AI settings and generation, custom base URL, HTTPS/private-host protection and schema support. Exact private hosts can only be enabled by the operator's server environment. Default webhook SSRF restrictions remain unchanged.                                                                                                    |
| `0a68832`                                           | Stored AI key can only be reused for the same provider and normalized endpoint.                                                                                                                                                                                                                                                                                   |
| `55e092f`                                           | AI reply slot checks pause/human assignment, latest-inbound check, any-keyword knowledge search, partial/keyword-only indexing feedback, paged usage with caller timezone, and expiring/invalidateable AI status cache.                                                                                                                                           |
| `dff99c9`                                           | Paused/archived flow run closure, reply-time timeouts, current-node validation, active-save validation, automatic-node cycle checks, transactional graph replacement, and claimed reply transitions. RZ send targeting and authorization retained.                                                                                                                |
| `0fd470b`                                           | Newest-200 thread load, older pages, scroll preservation, failed/local bubble retention and paged dashboard series/reply-time queries. RZ exact-ID message reconciliation and forward-only acknowledgement status retained instead of upstream text-based guessing. Older-page cursor also compares ID when timestamps tie; stale conversation loads are ignored. |
| `8125256` (RPC portion)                             | Broadcast recipient parameters transported as a JSONB array and paired by ordinality. Existing semantic payload preparation, atomic campaign creation and delivery-unknown guards retained.                                                                                                                                                                       |
| `feb50df`                                           | Per-user budgets before administrative Meta calls, media requests and manual automation triggering. Existing per-number send pacing remains separate.                                                                                                                                                                                                             |
| `bf39722` (stable cursor portion)                   | Persist the wait step ID, resolve its current position at resume, and suppress a deleted/changed wait. Existing RZ leasing, retry acceptance markers, completion identities and timezone policy retained. No second pending queue or claim timestamp added.                                                                                                       |
| `617d211` (adapted portion)                         | Protect account identity columns; serialize role/removal/ownership mutations with profile/account/membership locks. Retain `account_members` and cross-workspace memberships. Missing caller roles fail closed. Invitation redemption remains non-destructive.                                                                                                    |
| `ee0a3cd` (missing setup guard)                     | Require admin before manual connection setup reaches service-role lookups or Meta. Existing atomic, history-preserving connection deletion retained.                                                                                                                                                                                                              |
| `82a8cd6`                                           | Run Turbopack PostCSS through worker threads; verified necessary for the build environment.                                                                                                                                                                                                                                                                       |
| `fbabe3f`, `106fe5d`, `7287c2a` (supporting pieces) | Translation helper/catalog support for the adopted modules and a build-time active-catalog alias. Existing RZ translation strings are preserved; missing upstream keys were added.                                                                                                                                                                                |

## Existing RZ behavior deliberately retained

- Theme, favicon and reservation-filter fixes from `307996b` are unchanged by this integration.
- PMS providers, webhook processing, reservation synchronization, property context and lifecycle handling are unchanged.
- PMS automations retain property timezone; general automations retain workspace/user timezone.
- One existing automation engine/trigger queue and the existing pending-continuation worker remain canonical.
- Semantic template preparation, canonical variables, prepared Meta payloads and template compatibility checks are unchanged.
- Coexistence signup, sync intents, import worker, connection resolver, service-window exclusions and durable webhook delivery handling remain intact.
- Permanent conversation deletion and history-preserving connection deletion remain intact.
- Inbox HTTP acknowledgements retain database/provider IDs and never infer delivery/read from acceptance. Realtime and resync use exact identities rather than text matching.
- Existing storage policy hardening, private page caching, broadcast pagination and forward-only webhook statuses remain in place.
- The optional dashboard redesign, a new interactive wait-for-reply feature, migration renumbering/history rewrites and blanket dependency/runtime upgrades were not mixed into these fixes. AI/Agents and Flows feature/fix changes were included as requested.

## Database deployment requirement

Apply **`supabase/migrations/86_upstream_ai_flows_integrity.sql` before deploying this application revision**, after the existing migration chain through 85. It adds AI provider/base URL support, guarded AI reply claims and FTS behavior, flow run integrity, quick-reply content checks, the JSONB broadcast RPC, stable wait cursors and RZ-specific account protections. Historical migrations were not edited. The CI schema smoke check was updated for the new broadcast RPC signature and integrity columns/privileges.

The migration was applied only to a newly initialized disposable PostgreSQL 14 instance on `/tmp/rz-upstream-pg-socket`, port `55447`, database `rz_upstream_integrity_test`. **No hosted database or production service was changed.**

Existing quick replies are not bulk rewritten; the new content constraint is NOT VALID so existing rows remain readable while new/updated content is checked. Existing native AI provider rows remain valid without a base URL. The stored wait cursor is optional for pre-migration pending runs.

## Validation

- Before integration: 199 test files passed; **2,362 tests passed / 135 skipped**.
- Integrated application suite: 221 test files passed; **2,538 tests passed / 150 skipped**. The additional 15 skipped tests are the explicit disposable-database suite, executed separately below.
- Disposable PostgreSQL suite: **15 tests passed**, covering eligible/capped/paused/assigned AI replies, service-only RPCs, compatible-provider constraints, account-scoped any-term FTS, variable-length broadcast parameter pairing and rollback, quick-reply validation, authorized/foreign graph replacement, direct identity protection, missing-membership denial, cross-workspace ownership transfer, concurrent transfer/removal, and the stable wait cursor.
- Added regression coverage for wait reordering/removal, exact-ID resync with simultaneous identical sends, preserving read acknowledgements, and admin/rate-limit refusal before manual setup side effects.
- Typecheck, scoped ESLint and production Next build passed. Build used dummy service credentials. Existing Next middleware/Edge runtime deprecation warnings remain.
- `git diff --check` passed. No tracked paths were deleted. Original RZ history, including `307996b`, remains ancestral to the integration branch.

The SQL suite uses a minimal fixture matching the affected contracts; it is **not** a full Supabase migration replay. Hosted migrations/RLS, actual PostgREST transport, live Meta sends, provider calls, browser flows and production E2E were not tested. Existing unrelated optional database suites remain skipped. Do not describe this as production-deployed or live-verified.

## Reproduce the focused database checks

Use a fresh, isolated PostgreSQL instance, never a shared application database:

1. Initialize a cluster owned by the current OS user, listening only on Unix socket `/tmp/rz-upstream-pg-socket`, port `55447`, with superuser `postgres`.
2. Create `rz_upstream_integrity_test`.
3. Apply `src/lib/test-fixtures/upstream-integrity-schema.sql`, then the actual migration 86 to that database with `psql -v ON_ERROR_STOP=1`.
4. Run `RZ_UPSTREAM_PG_TEST=1 node node_modules/vitest/vitest.mjs run src/lib/upstream-integrity.pg.test.ts` using the bundled modern Node runtime if the ambient Node/jsdom combination is incompatible.

The test runner uses that fixed socket/port/database and requires the fixture's explicit database comment before truncating its test tables. It does not read application connection credentials.
