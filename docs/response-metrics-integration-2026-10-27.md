# Response metrics correction

Implemented on `codex/response-metrics`, based on `a240e21`. This adopts the response-classification intent of upstream `a20253a`, adapted to RZ attribution, Coexistence provenance and memberships. It does not import the upstream dashboard replacement or automation reply-wait feature.

## Result

The existing response-time card now has explicit **CRM team** and **AI** selectors. Each shows average first-reply minutes by weekday, this week and last week, in the saved workspace timezone. A query failure displays an error and Retry instead of an empty or fabricated zero result. A day without samples remains null, distinct from a real zero-minute response.

A customer turn is a consecutive burst of eligible customer messages, ignoring failed sends and deterministic bot acknowledgements. It ends when a qualifying human/AI reply arrives; a subsequent customer burst begins a new turn. The first human and first AI reply in that turn are measured separately. For example, customer at 10:00, bot acknowledgement at 10:01, AI at 10:02, teammate at 10:15 produces AI=2 minutes and human=15 minutes. An AI reply to a later turn cannot inherit an old unanswered AI wait from a previously human-answered turn.

Qualifying replies have status `sent`, `delivered` or `read`. Human samples require `sender_type=agent`, a recorded `sender_id`, and no AI flag. AI samples use `ai_generated=true`. Imported history, revoked/placeholder messages, in-flight/failed sends and future timestamps do not contribute. App echoes and API sends without a recorded human actor are excluded. Unknown historical actors are never backfilled or guessed, so historical human averages may have fewer/no samples. Existing attributable human and eligible AI messages can still contribute.

## Database and attribution

Forward migration **88_response_metrics.sql**:

- Replaces the existing `record_whatsapp_outbound` function with the same body plus `sender_id` on INSERT. The actor comes only from an authenticated JWT's `auth.uid()`. Service/API sends stay unattributed even if their JWT sub or supplied JSON names a user. The optional payload cannot impersonate another teammate.
- Preserves the function signature, guards, atomic message/preview persistence, frozen template snapshot, exact provider identity, duplicate no-op/read-status preservation and agent handoff. A replay does not rewrite an old actor or snapshot.
- Adds an ordered conversation/timestamp/ID index and one read-only `dashboard_response_metrics(p_account)` RPC, **SECURITY INVOKER**, restricted to authenticated callers. It enforces current selected workspace plus real membership, with table RLS still active. It uses `accounts.default_timezone`; no caller-provided browser timezone overrides it.
- Aggregates inside PostgreSQL to avoid a REST row cap. It reads the reporting interval plus one preceding eligible message per active conversation, so an old customer burst spanning the reporting boundary does not become a false new turn. Ordering includes IDs for tied timestamps. Local calendar boundaries are converted with `AT TIME ZONE`, including daylight-saving changes.
- Does not change message statuses, backfill identities, update service-window timestamps, add queues or alter existing migrations.

Apply migration 88 **after migrations through 87 and before deploying the application**. This migration was applied only to a disposable local database during development. Hosted migration status was not inspected; no hosted database was changed or application deployed.

## UI and preservation

The response card loads independently through `useResponseTime`; its scope includes workspace, timezone and membership readiness. Switching workspace immediately hides the previous result, and late responses are ignored. Retry and failure states are covered by UI tests. New labels were added to the existing English, Spanish, Portuguese and Korean response-card catalog blocks only.

The other dashboard widgets, forest/gold theme, reservation filters, PMS lifecycle/synchronization, property-timezone scheduling, semantic templates, Coexistence import/send behavior, automation/flow execution and durable webhook stages were not edited. Prior integration commits `307996b`, `73a0ef9` and `a240e21` remain ancestors. No tracked paths were deleted. The earlier review document remains intact.

## Validation and limits

- Full application suite: **2,575 passed / 170 skipped**; 228 test files passed. Twelve of the skipped tests are this change's explicit opt-in database suite, run separately below.
- Actual migrations 87/88 applied against a new marked **local PostgreSQL 14** fixture with RLS and the repository's `account_members`-based membership function. **12 SQL tests passed**: human/AI timing, acknowledgements/failures, customer bursts, history/echo/unattributed/revoked exclusions, period boundary context, future/in-flight sends, tied timestamps and zero duration, workspace timezone, >1,000 samples, selected-workspace authorization/viewer reads, verified actor attribution, service-role non-attribution, snapshot/replay/read status/handoff and grants.
- UI tests cover independent selectors, null versus zero, errors/retry, immediate workspace clearing, late request rejection, membership readiness and timezone reload. Typecheck, scoped ESLint, formatting, diff checks and the production build passed. Build used placeholder credentials.
- Synthetic RLS benchmark: 5,000 conversations and 50,000 messages (40,000 older context messages) returned the expected 5,000 reply samples; the timed query took **about 246 ms** locally. This is a fixture measurement, not a hosted performance guarantee.
- Automated Supabase CLI advisors could not connect to this Unix-socket fixture because its connection-string handling rewrote the socket path. Direct catalog checks and authenticated RLS/permission tests passed. No hosted advisor request was substituted.
- The fixture is not a full Supabase schema/migration replay. No live PostgREST request, browser/account/provider E2E, real WhatsApp send or deployment was performed. Other dashboard metrics retain their existing behavior and date policy; only response metrics are changed here.

Reproduce database checks in a fresh local instance listening on `/tmp/rz-upstream-pg-socket`, port 55447: create `rz_response_metrics_test`, apply `src/lib/test-fixtures/response-metrics-schema.sql`, then actual migrations 87 and 88, and run `RZ_METRICS_PG_TEST=1 node node_modules/vitest/vitest.mjs run src/lib/dashboard/response-metrics.pg.test.ts`. The test requires the fixture's database marker before truncation. Never point it at an application/shared database.
