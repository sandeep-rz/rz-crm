# Automation Retry-Safety Correction Report

Corrected locally on 2026-10-08. No remote database changes or real WhatsApp sends. This report supersedes the retry-safety descriptions from the preceding implementation report; the previously implemented Activity table remains unchanged.

## Final focused correction: root fencing and guard scope

Only these five files changed in the final pass:

- `src/lib/automations/engine.ts`
- `src/lib/automations/semantic-template.test.ts`
- `src/lib/automations/manual-retry.pg.test.ts`
- `supabase/migrations/72_automation_duplicate_retry_safety.sql`
- This report.

The migration already existed under its current `72_...` name when this pass edited it. No new migration, schema field, or state was introduced.

### Non-PMS dispatch/retry finding (reported before changing guard scope)

`runAutomationsForTrigger()` invokes `executeAutomation()` without an execution identity. The executor inserts a fresh log and does not enqueue a root retry. Webhook dispatch, contact-tag events, and `POST /api/automations/engine` use that path. Repeated trigger/API calls create new executions; they do not resume the old execution log.

Only `pms-worker.ts` supplies `AutomationExecutionIdentity` to `runAutomationForTrigger()`, enabling the existing PMS acquisition/retry path. The manual retry endpoint calls `retryPmsAutomationExecution()`, and its SQL RPC requires `trigger_job_id IS NOT NULL`. There is no current automatic/manual root retry path for ordinary non-PMS logs.

Consequently `executeAutomationStep()` now requires recording only for duplicate-sensitive actions with `triggerJobExecution` or `retrySafetyContinuation`. Non-PMS roots use their existing action path without the safety RPC. Non-PMS Wait continuations still require recording because the pending worker can retry/reclaim their saved segment.

### Root versus Wait fencing

The existing recording RPC still locks the original PMS job first when one exists. With no pending execution ID, it now requires both a matching job/log attempt and `job.status = 'processing'`. A completed job rejects a stale root before guard mutation or the guarded external action.

With a pending execution ID, the pending row is the authoritative claim: its ID, account, log, automation, `running` status, and attempt must match. An original PMS job already marked `completed` therefore does not reject a valid Wait continuation. Original PMS attempt/status fencing is not substituted for pending claim validation.

Permanent and same-step unknown guards, successful-step fallback, round-robin protection, manual/automatic root blocking, and continuation-local replay rules remain unchanged.

### Focused coverage

- PostgreSQL: processing root allowed; completed root refused without recording a guard.
- Engine: rejected guard writes prevent the sender from crossing the external boundary for PMS roots and Waits.
- PostgreSQL: valid pending continuation records safety after original PMS completion; wrong pending ID/account/log/automation, wrong attempt, and non-running status are refused without changing either guard.
- Non-PMS dispatch succeeds even when the recording RPC is unavailable; its send receives no safety hooks.
- Non-PMS Wait sends still receive safety hooks and record acceptance.
- Existing pre-Wait-send/safe-continuation and in-segment-send/replay-block tests remain passing.

Final validation: **316 regression tests + 58 isolated PostgreSQL tests = 374 passing tests**. Typecheck, scoped ESLint, and diff checks passed. The one live-Meta test was not run. No remote database was modified.

The sections below describe the complete containment patch, including the preceding correction.

## 1. Exact files changed in this correction

- `src/lib/automations/engine.ts`
- `src/lib/automations/engine.test.ts`
- `src/lib/automations/pending-worker.ts`
- `src/lib/automations/pending-worker.test.ts`
- `src/lib/automations/semantic-template.test.ts`
- `src/lib/automations/manual-retry.pg.test.ts`
- `src/lib/automations/template-send-error.ts`
- `supabase/migrations/72_automation_duplicate_retry_safety.sql`
- `docs/automation-retry-safety-implementation.md`

Earlier uncommitted Activity/UI and sender changes were preserved. No new tables, migrations, queues, cursors, action histories, or checkpoint engine were added.

## 2. Final meaning of retry_safety

`automation_logs.retry_safety` is an execution-wide restart guard: the execution contains evidence that restarting from the beginning could duplicate an external/non-idempotent action.

It retains the first blocking action, rather than becoming an action history. `external_action` is conservative evidence recorded before an action; the action may have happened even if its completion was not saved. A guard does not interrupt later actions within the same ongoing execution.

## 3. Allowed state transitions

| Existing state | Incoming evidence | Result |
| --- | --- | --- |
| Empty | Any valid blocking evidence | Record evidence |
| `whatsapp_unknown` | Same step, proven failure before a Meta request | Clear |
| `whatsapp_unknown` | Same step, returned provider ID | Upgrade to `whatsapp_accepted` with ID |
| Any guard | Another step tries to clear it | Preserve |
| `external_action` or `whatsapp_accepted` | Later unknown, accepted, or clear operation | Preserve original evidence |
| `whatsapp_unknown` | Evidence from a different step | Preserve original evidence |

SQL now permits acceptance upgrades only from the same step's unknown state. TypeScript uses structured preparation errors or `failedBeforeMetaRequest` proof for narrow clearing. It no longer infers pre-request failure from an HTTP response status.

## 4. Automatic whole-job retry

The existing PMS worker checks `automation_retry_block_reason()` before execution and again after failure before scheduling a retry. Blocking evidence makes the failure terminal/non-retryable. Safety lookup failures remain conservative.

The helper uses structured `retry_safety` or successfully persisted duplicate-sensitive `steps_executed` entries. It does not parse stored error messages. The `begin_pms_automation_execution()` RPC retains the same defense under the job lock.

Failures before the send boundary remain eligible according to existing retryability. Missing success entries alone do not establish safety: the durable pre-action guard covers uncertain outcomes.

## 5. Manual retry

The existing eligibility RPC and authoritative retry RPC use the same SQL helper and return `unsafe_to_retry` when replay is unsafe. Manual Retry cannot bypass the guard.

Existing account isolation, latest-attempt checks, completed-occurrence suppression, `FOR UPDATE`, and the guarded `failed` to `scheduled` transition remain unchanged.

## 6. Meta unknown and accepted states

- Preparation and connection/recipient checks precede the send boundary.
- Before a Meta request, the sender must successfully persist `whatsapp_unknown`.
- A guard write failure prevents the external action.
- A returned provider ID upgrades that step's unknown guard before local message persistence. An already permanent guard from an earlier action is preserved instead of overwritten.
- Local persistence failure after acceptance cannot authorize replay.
- Unknown outcomes remain blocked.
- A structured, proven same-step failure before the request can clear only that step's unknown guard.
- HTTP responses, including 429, are not proof that the request was never submitted; they no longer clear the guard merely by status.

Acceptance is not a delivery guarantee. Stored error text is retained for diagnostics, not reconstructed into retry eligibility.

## 7. Assignment correction

Removed generic `assign_conversation` from the SQL successful-step fallback because those entries do not record assignment mode. Explicit assignment therefore does not become unsafe solely from its step type.

Runtime classification still guards `mode === 'round_robin'` before its non-idempotent assignment operation. Its durable evidence blocks whole-execution restart.

The successful-step fallback still covers `send_template`, `send_message`, `send_buttons`, `send_list`, `send_webhook`, and `create_deal`.

## 8. Exact Wait continuation behavior

The existing pending row, saved scope/position, claim attempts, queue, completion markers, and backoff are reused.

A small structured latch lives in the existing `automation_pending_executions.context.__retry_safety`. This is continuation-local replay evidence, not a new schema field or position checkpoint.

1. The worker's atomic claim returns the pending row and its persisted context.
2. A recorded completion marker still permits bookkeeping recovery without replaying actions.
3. Otherwise, the engine blocks replay when that pending row contains a segment-local guard. The execution-wide log guard is not used to block continuation replay.
4. Actions inside the continuation pass its existing pending ID and claim attempt into `record_automation_retry_safety()`.
5. That RPC atomically maintains both whole-execution protection and the local latch before the side effect. It validates the pending row's account, automation, log, running state, and attempt.
6. On failure, the pending worker rereads the current persisted local latch rather than using its stale pre-action claim snapshot. Uncertain in-segment actions make the continuation terminal. No local latch allows the existing bounded retry behavior; lookup failure fails closed.
7. The local key is stripped from runtime context before execution, so a subsequently scheduled Wait starts a new segment without inheriting the preceding segment's evidence. The continuation identity remains available through nested child scopes for safety writes.

A pre-Wait send therefore still blocks restart from root but does not block a harmless scoped continuation retry. A send/webhook/deal/round-robin action within the replayed segment blocks replay if that segment subsequently crashes or cannot persist completion.

Existing ordinary caught step-failure/finalization behavior was not redesigned. The new check controls the existing continuation retry/reclaim path.

## 9. Remaining continuation duplicate risk

For the covered duplicate-sensitive actions, a successfully recorded local latch prevents blind replay of an unfinished segment, including a crash after the action but before completion persistence. The tests include an actual engine/sender-hook continuation followed by failed completion persistence and a blocked second attempt.

This does not repair unrelated branch/Wait semantics or deduplicate repeated creation of pending rows. It also cannot reconstruct outcomes from historical executions lacking structured evidence. Those are outside this containment correction; no general recovery engine was introduced.

## 10. Migration changes and security review

Edited the existing under-development migration directly; no stacked migration.

- Removed all three stored-error heuristics from `automation_retry_block_reason()`.
- Retained successful-step defense-in-depth, excluding generic assignment.
- Made guard updates monotonic and same-step acceptance/clear operations narrow.
- Extended the existing recording RPC with optional pending ID/attempt parameters and atomic local-latch updates in existing context.
- Preserved acquisition and manual-retry enforcement.
- Preserved account filtering and empty `SECURITY DEFINER` search paths.
- Restricted helper/record/retry execution to `service_role`, with browser/public privileges revoked.
- Guard writes lock the trigger job first, then the pending row when applicable, then update the execution log. The completion RPC only updates the log; the claim RPC only locks pending rows, so neither introduces the reverse lock order.
- Stale whole-job or pending claim attempts cannot cross the guarded side-effect boundary.

Only the disposable local PostgreSQL fixture was updated for validation. Its test-only marker was checked before fixture reset. Production deployment still requires applying the finalized migration before application code that calls the revised RPC.

## 11. Tests and results

- Relevant regression suite: **316 passed**, across 21 passing test files.
- Ordinary run: 58 opt-in PostgreSQL tests and one live-Meta test skipped.
- Isolated local PostgreSQL RPC suite, run separately: **58 passed**.
- Total distinct passing tests: **374**.
- Typecheck: **passed** (`tsc --noEmit`).
- ESLint on the three TypeScript/test files changed in the final pass: **passed**.
- `git diff --check`: **passed**.

The regression command covered `src/lib/automations`, `src/components/automations`, the Activity page tests, automation API tests, and `src/lib/flows/meta-send.test.ts`.

Coverage includes safe preparation failures, automatic/manual root blocking, successful sends/webhooks/deal creation/round-robin followed by failure, provider acceptance and local persistence failure, unknown outcomes, pre-request same-step clearing, preservation of earlier permanent evidence, explicit assignment fallback, pre-Wait protection isolation, in-segment replay blocking, guard-write failures, completion recovery, existing successful execution, completed occurrences, account isolation, stale claims, RPC permissions, and current UI/API regressions.

## 12. Remaining limitations

Conservative containment can block an action whose guard was persisted even when the action never reached its provider; it does not promise exactly-once execution. Proven pre-request WhatsApp failures are the narrowly supported clearing case.

Historical records without structured guards cannot be safely reconstructed from error strings. No live Meta test, external delivery verification, remote deployment, or broader branch/Wait recovery work was performed.
