# WhatsApp onboarding runtime hardening

12 October 2026. Implementation follows [the agreed plan](whatsapp-onboarding-implementation-plan.md). Development host: `https://dev-crm.rukiyezara.com`. Supabase: `ideibnrtszjdrxsusnwc`, confirmed by the owner as the single project currently used for development.

## Implemented

| Finding                              | Change                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public internal mutations            | Migration 79 removes anon/authenticated access to six audited internal functions, including the additional broadcast-count repair helper found in the final advisor pass. Unsafe global merge helpers are retired. Internal trigger/server callers remain supported.                                                                                                                                                             |
| Ordinary deliveries lost after ACK   | The signed endpoint commits a bounded batch to the existing receipt ledger before returning 200. Storage failure returns 503. Ordinary messages/statuses have separate stable provider identities.                                                                                                                                                                                                                               |
| Processing interrupted after insert  | Canonical rows retain receipt ownership. Transactional inbox bookkeeping and durable fan-out stages repair unfinished work. First-contact/conversation intent survives row creation, and an atomic claim prevents concurrent messages from both firing the first-inbound welcome.                                                                                                                                                |
| Unresolved coexistence events        | Raw signed deliveries remain pending until server-side routing and verified mode are available. No workspace is guessed.                                                                                                                                                                                                                                                                                                         |
| Unfair draining/history backlog      | Claims use short leases, SKIP LOCKED, bounded retries and lifecycle/live/history priorities. A locked connection is skipped rather than ending the importer. Relevant partial indexes bound hot-path scans.                                                                                                                                                                                                                      |
| Missing sync after finalization      | The existing connection state is scanned by the internal worker for missing one-time requests. Completed signup replay reconciles background sync. Accepted/unknown requests are never reset for blind retry.                                                                                                                                                                                                                    |
| Misleading sync results              | Refused claims reread authoritative state. Definite Meta rejections are recorded separately from uncertain outcomes. The frontend displays pending work and active progress. Deadline text avoids promising that generic reconnect restarts history.                                                                                                                                                                             |
| Multi-instance sending               | One atomic PostgreSQL allowance per phone covers text, media, templates, interactive buttons/lists and reactions. A conservative 20 messages/second applies to all numbers until higher standard-number capacity is independently verified. Read/typing notifications preserve their existing behavior.                                                                                                                          |
| Prepared broadcast after offboarding | Common send checkpoints check current connection state and captured pending offboarding. Definite local refusals preserve unsent recipients in the existing pending/resume path. Accepted/unknown sends retain their duplicate barriers. Inbox/API quota responses are explicit 429s; known local refusals also preserve safe retry in the existing automation continuation/job system without retaining an unknown-send latch.  |
| Rich imported content                | Preserve reply references, locations, interactive selections and filenames. Resolve late reply parents efficiently. App edits/revokes update the original message monotonically, without unread/automation effects; late history/media cannot revive a revoked message.                                                                                                                                                          |
| Unbounded setup discovery/retention  | Discovery returns at most 20 current attempts. Expired staged credentials are cleared; uncertain registration barriers survive expiry. Ordinary raw failed payloads have a 30-day retention window; exhausted normalized Coexistence records stay available for operator review and safe retry; completed receipt rows expire after 30 days, while canonical message identities continue suppressing duplicate inbound handling. |
| Setup complexity                     | Business app is the default. The panel prepares SDK/session before the direct Facebook click, exchanges short-lived codes promptly, handles WABA-only completion and classifies migration/grant-only flows. Connected users get Open inbox. Detailed eligibility information is collapsed; manual setup stays under Advanced Options.                                                                                            |

No additional incoming webhook, message provider, automation engine or scheduler was introduced. The internal worker dispatches the existing handlers; the existing `whatsapp-coexistence-import` job also wakes TypeScript recovery.

## Follow-up production-readiness fixes

- Broadcast reply attribution commits with inbox bookkeeping in the existing receipt transaction. Receipt replays and distinct follow-up inbound messages keep selecting the latest eligible broadcast, including when already replied; matching requires the same workspace, contact and WhatsApp connection, and a send preceding the inbound timestamp.
- Template status/quality lookup, update, stub insertion and conflict-repair database errors propagate to the existing durable worker. Repeated updates and unique-conflict repair remain idempotent.
- Unmatched delivery statuses remain pending in their existing receipt until a connection-scoped Inbox message or broadcast recipient appears. Broadcast-only matches succeed without requiring an Inbox row, including duplicate or regressive events. The same connection is required; late success statuses cannot revive terminal failed messages or recipients. Status fan-out reflects the persisted state.
- Exhausted normalized Coexistence imports remain stored. Service-only inspection returns safe metadata, and an explicit retry checks workspace, current onboarding epoch, retained records and inactive leases. Raw external action stages are never reset by this API.
- History progress remains monotonic. Backend completion waits for previously received normalized chunks; the UI also checks pending raw history receipts and exhausted imports. Failed aggregate reads return 503 rather than reporting completion without backlog evidence.
- Manual updates reject Coexistence phone/WABA replacement. A database trigger also protects phone, WABA, workspace and coexistence mode from direct changes/races. Same-identity credential/name updates and standard Cloud API updates remain supported.
- Between ordinary deliveries the existing worker drains one lifecycle/live import, then at most five historical batches after live processing. Cron prioritizes lifecycle/live work before waking the same worker; SQL-only recovery falls back to five batches when worker secrets are absent. Each batch retains the existing 100-record bound.

To inspect and retry a failed normalized import, use service/admin access after reviewing and fixing its cause:

```sql
SELECT * FROM public.inspect_whatsapp_coexistence_failures('WORKSPACE_UUID'::uuid);
-- Choose the reviewed receipt ID from the scoped result above.
SELECT public.retry_whatsapp_coexistence_event('WORKSPACE_UUID'::uuid, RECEIPT_ID);
SELECT public.wake_whatsapp_worker();
```

A false retry result means the receipt is not currently eligible; do not bypass the checks or reset uncertain delivery stages. Unsupported payloads require a handler correction before retry. Exhausted normalized records now require explicit reviewed resolution rather than automatic retention deletion. Truly unmatched status events exhaust their bounded retry allowance and remain visible for operator review; the system does not fabricate an outbound message.

## Safety boundaries and remaining limits

External API actions and PostgreSQL commits cannot be atomic. A stage interrupted after its durable claim has an unknown outcome: automatic replay blocks that stage and keeps the receipt for review. Never reset that marker without checking flow/automation/Meta evidence. This is conservative recovery, not a claim of exactly-once external delivery.

A quota refusal occurs before HTTP. Sequential sends may wait once, for at most 75 milliseconds, then recheck shared allowance/lifecycle. Broadcasts retain pending recipients for the existing resume action. Existing automation continuations/retry policies remain canonical; this change does not add automatic replay of every failed inbound automation.

Meta decides number eligibility, phone ownership verification and supported provider sharing/migration. Personal WhatsApp is not app coexistence. Account-only standard completion remains awaiting phone setup; ambiguous selection requires completion in Meta rather than guessing a number. Billing remains `not_verified` until separately verified in WhatsApp Manager.

Migration 79 is backward compatible with the existing manual connection. Deployment of the application and worker configuration are separate steps. One project is development today; a separately isolated production environment, backups/restore rehearsal and expected workload measurements are still release requirements.

## Worker activation

1. Apply migration `79_whatsapp_runtime_hardening.sql`, then deploy this application revision to the development host. Keep `NEXT_PUBLIC_SITE_URL=https://dev-crm.rukiyezara.com`, the correct Supabase URL/keys, `META_APP_SECRET` and the existing `ENCRYPTION_KEY` configured. Retain that encryption key so saved manual credentials remain readable. Validation used Node 24.
2. For app-level Meta webhook verification, optionally configure server-only `META_WEBHOOK_VERIFY_TOKEN` and use the same token for `https://dev-crm.rukiyezara.com/api/whatsapp/webhook` in the Meta app dashboard. This works before any customer connects and avoids scanning customer tokens. Legacy per-connection tokens remain supported.
3. Generate a long random worker token (for example, locally with `openssl rand -hex 32`). Configure server-only `WHATSAPP_WORKER_TOKEN` in the deployment environment, and the same value in Supabase Vault under `whatsapp_worker_token`.
4. Configure Vault `whatsapp_worker_url` to `https://dev-crm.rukiyezara.com/api/whatsapp/webhook/worker`. Do not use the public signed incoming endpoint for cron.
5. Restart/redeploy after environment changes. Verify that an unauthenticated worker request returns 401 and an authenticated request returns processing counts.
6. Execute `SELECT public.wake_whatsapp_worker();` and verify the existing cron job plus pg_net response status. Never expose Vault values, headers or raw webhook payloads in logs.

Before those secrets exist, the updated cron still processes SQL imports and retention, but cannot recover ordinary TypeScript deliveries or initiate missing Meta sync. `after()` lowers latency and is not the durable recovery guarantee.

The new migration was created through the Supabase CLI, then named `79_whatsapp_runtime_hardening.sql` to follow this repository's legacy numbering. A timestamp filename sorts before migrations 54–78 in a clean CLI replay. Keep remote migration history aligned with version 79; do not renumber applied historical migrations.

## Operations

Inspect safe aggregate state with service/admin access:

```sql
SELECT event_kind,
       count(*) FILTER (WHERE processed_at IS NULL AND attempts < 10) AS pending,
       count(*) FILTER (WHERE processed_at IS NULL AND attempts >= 10) AS needs_review,
       min(created_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending
FROM public.whatsapp_coexistence_events
GROUP BY event_kind;

SELECT id, event_kind, attempts, last_error, retry_at, lease_until
FROM public.whatsapp_coexistence_events
WHERE processed_at IS NULL
ORDER BY priority, retry_at, id
LIMIT 50;

SELECT jobname, schedule, active, command
FROM cron.job
WHERE jobname = 'whatsapp-coexistence-import';
```

Investigate any `external_stage_outcome_unknown`, exhausted attempts, unresolved routing, failed cron wake-up, sync deadline risk, or a rising oldest-pending age. Add alerts in the deployment/DB monitoring service before a production release. Do not treat an empty queue as proof that the worker credential or Meta subscriptions are configured.

Retain canonical data and receipts on rollback. Reverting application code removes TypeScript durable recovery; do not roll back security grants, drop the ledger or delete uncertain-registration markers. Disable the worker wake-up by removing its Vault URL if needed, while preserving SQL imports.

## Live release gates

- Authenticated evidence of Meta app Live mode, Tech Provider approval, Advanced Access for both WhatsApp permissions and hosted Login for Business v4 products. SDK/session versions do not prove v4. Meta's current documentation retires signup v2/v3 on 15 October 2026.
- Exact HTTPS app domains/redirects and app-level `messages`, `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` subscriptions.
- Dedicated test Business app number: full coexistence signup, app confirmation, accepted/declined history sharing, app/API messages both ways, rich media/replies, edit/revoke, worker interruption/recovery, device offboard/reconnect. Verify zero coexistence registration calls.
- Dedicated unused number: account creation/selection, SMS/voice verification, guarded registration, reload/recovery and real messaging. Preserve the existing manual connection throughout.
- Real deployment/runtime verification, successful cron HTTP wake-up, mixed-source workload measurements, operational alerts, customer-direct Meta payment setup and backup/restore readiness.

The owner will deploy the application, apply migration 79 and complete the live Meta tests. An attempted connected-tool migration returned an expired request-state error; a subsequent read confirmed that the new runtime schema and migration were absent. No development migration was applied by this task.

## Validation record

- All migrations 001–79 replayed from scratch on a disposable Supabase PostgreSQL 17 database; repository schema/security assertions passed.
- **48 actual PostgreSQL tests passed**, covering authorization/lease fencing, one-time sync, shared allowances, captured offboarding, tenant-scoped statuses, fair draining, rich history, duplicate unread handling and concurrent first-inbound intent.
- Latest narrow broadcast follow-up: **97 relevant unit tests passed**, none skipped; **48 PostgreSQL tests passed**, none skipped. Clean 001–79 replay, live schema/function dependency inspection, schema/security assertions, TypeScript and changed-file lint passed. No remote migration was applied.
- **2,244 tests passed** in the earlier full Vitest run. Six existing translation catalogue/ICU tests fail in untouched `src/i18n/messages.test.ts`; integration/optional suites remain skipped in the normal run. The WhatsApp/onboarding/Inbox/template/broadcast/automation compatibility run passed 1,117 tests; 110 optional integration tests were skipped in that run. The guarded PostgreSQL suite was run separately. The full run skipped 112 optional tests.
- TypeScript, lint for changed TypeScript/TSX files and `git diff --check` passed.
- Production build passed with Next.js's supported **webpack** compiler. The local default Turbopack build encountered a sandbox port-binding restriction; it was not a successful hosting-runtime check.
- Existing manual compatibility paths remain covered. The owner will apply migration 79 and deploy; **no remote migration or real Meta message/signup was performed successfully by this task**.

Live Meta configuration, deployment/cron HTTP recovery and actual number onboarding remain required before production sign-off.

Primary references: [Meta implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation), [coexistence](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users), [echo/edit/revoke reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes), [automatic reconnection](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/reconnect-offboarded-coexistence-clients/), [Supabase private function remediation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

The advisor also reports existing Auth password protection, extension placement, mutable search paths and public auth/trigger helpers. Their presence is recorded separately from these six confirmed internal mutation defects; do not blanket-revoke authorized membership or invitation APIs. Review the [Auth protection setting](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) as a platform release requirement.
