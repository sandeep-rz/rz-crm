# RGCRM Automation Retry/Resume Audit

Audit date: 2026-10-08.

**Primary verdict: YES — a retry can execute an already-successful `send_template` again after a later step fails.**

**Secondary verdict: YES — manual Retry can resend after Meta accepted the message but local persistence failed.** Automatic retry is disabled for the specifically recognized template message-insert failure, but other ambiguous failure boundaries remain.

This was a read-only repository audit. No implementation code, migrations, or database records were changed. Live Meta delivery and deployed database state were not tested.

## 1. Current Execution Model

```text
PMS webhook processed and reservation synchronized
→ schedulePmsAutomationsAfterSync()
→ automation_trigger_jobs occurrence created/upserted
→ worker atomically claims job and increments attempt_count
→ worker revalidates current automation/reservation
→ begin_pms_automation_execution() acquires attempt identity
→ new automation_logs row with empty steps_executed
→ executeStepsFrom(root, position 0)
→ actions run
→ accumulated results appended to automation_logs
→ execution marked failed, completed, or suspended at Wait
→ worker updates trigger job
```

| Stage | Existing implementation |
|---|---|
| Schedule occurrences | `src/lib/automations/pms-scheduler.ts:269`, `schedulePmsAutomationsAfterSync()` |
| Claim and dispatch | `src/lib/automations/pms-worker.ts:94`, `processPmsAutomationJob()` / `runPmsAutomationJobWorker()` |
| Acquire attempt identity | `supabase/migrations/71_manual_pms_automation_retry.sql:12`, `begin_pms_automation_execution()` |
| Execute action tree | `src/lib/automations/engine.ts:322`, `executeAutomation()` / `executeStepsFrom()` |
| Prepare and send template | `src/lib/automations/engine.ts:695`, `executeAutomationStep()` → `engineSendTemplate()` |
| Meta call and local persistence | `src/lib/automations/meta-send.ts:115`, `sendViaMeta()` |
| Record progress/status | `src/lib/automations/engine.ts:1258`, `appendResults()` / `finalizeLog()` |

The execution gate prevents re-entering an already-completed occurrence or duplicating the same claimed attempt. It does not resume a new attempt from a previous attempt’s successful steps.

Non-PMS trigger dispatch uses the same executor but creates a new log without the PMS job identity. The existing manual Retry endpoint applies to PMS executions.

## 2. Current Retry Model

### Automatic PMS retry

When the engine returns a failed execution, the worker uses `execution.retryable`, defaulting to `true` when unspecified.

Retryable failures receive backoff of approximately one minute, five minutes, fifteen minutes, and one hour, subject to a five-attempt automatic limit.

The next claim:

1. Reuses the same trigger job.
2. Increments `attempt_count`.
3. Acquires a new attempt log.
4. Starts the current action tree at root position zero.

Expired processing leases can also be reclaimed. The gate checks for a completed occurrence and an existing log for the new current attempt, not a successful-step checkpoint from an older attempt.

### Manual Activity Retry

```text
ExecutionRetry
→ POST /api/automations/executions/{logId}/retry
→ retryPmsAutomationExecution()
→ retry_pms_automation_execution()
→ same job rearmed as scheduled
→ ordinary worker claim
→ new attempt log
→ root position zero
```

Sources:

- `src/components/automations/execution-retry.tsx:9`
- `src/app/api/automations/executions/[id]/retry/route.ts:8`
- `src/lib/automations/manual-retry.ts:53`

Manual Retry deliberately permits rearming terminal/non-automatically-retryable failures, including attempts beyond the automatic limit.

| Behavior | Automatic PMS retry | Manual Activity Retry |
|---|---|---|
| Same trigger job | Yes | Yes |
| New log after a new claim reaches execution | Yes | Yes |
| Old attempt preserved | Yes | Yes |
| Previous successful steps skipped | No | No |
| Starts at root position zero | Yes | Yes |
| Can repeat earlier successful sends | Yes | Yes |
| Honors automatic retryability/limit | Yes | Can rearm despite either |
| Uses current automation/reservation | Yes | Yes |

Neither deletes previous progress. Instead, the new attempt starts with empty progress and does not consult earlier progress.

### Wait continuation retry is different

`runPendingExecutionWorker()` retries an existing pending continuation row. It resumes from its saved parent, branch, and position, retaining the same automation log.

It can still repeat successful actions within that resumed segment if execution fails or crashes before its completion marker is recorded.

## 3. Duplicate-Send Verdict

**YES.**

The decisive evidence is:

- `begin_pms_automation_execution()` inserts each new attempt with `steps_executed = '[]'`.
- `executeAutomation()` always passes:

```ts
parentStepId: null,
branch: null,
startPosition: 0,
```

- `executeStepsFrom()` selects the action scope and executes its steps without checking prior attempts for completed step IDs.

Source: `src/lib/automations/engine.ts:419`.

```text
Attempt 1
  Step A: send_template succeeds
  Step B: fails
  Execution: failed

Attempt 2
  Step A: send_template executes again
  Step B: executes again
```

For automatic retry, this requires a retryable failure or eligible lease recovery. For manual Retry, it requires the existing RPC eligibility checks to pass.

The one-completed-occurrence constraint does not prevent this: Attempt 1 failed overall, despite Step A succeeding.

## 4. Meta Accepted / Local Failure Verdict

```text
prepareTemplateMessage()
→ buildMetaTemplateMessagePayload()
→ resolve conversation and validate sender/recipient
→ POST Meta /messages
→ parse response and obtain wamid
→ optionally update normalized contact phone
→ render local message body
→ insert messages row with wamid
→ update conversation preview
→ return wamid
→ collect successful step result
→ persist accumulated execution results
```

Sources: `src/lib/automations/engine.ts:695`, `src/lib/automations/meta-send.ts:249`, `src/lib/whatsapp/meta-api.ts:542`.

### Failure behavior after acceptance

| Boundary | Current behavior | Replay risk |
|---|---|---|
| Response parsing or accessing `data.messages[0].id` fails | No returned `wamid`; generic template failure becomes retryable | Accepted outcome may be unknown; automatic/manual resend possible |
| Contact phone normalization | Returned database error is unchecked; a thrown exception aborts sending | Thrown failure can become retryable after acceptance |
| Local body rendering | Occurs after Meta send; thrown error aborts the step | Can become retryable after acceptance |
| Message insert returns an error | Throws `meta_sent_message_persistence_failed`, `retryable: false` | Automatic retry stops; manual Retry still permits resend |
| Message insert throws rather than returning an error | Falls through generic template error handling | Can become retryable |
| Conversation preview update returns an error | Error is unchecked; sender returns success | Message may be recorded while preview is stale |
| Conversation preview update throws | Step fails after the message insert | Message exists, but automatic/manual retry can resend |
| Process dies before step results are persisted | Successful action may lack a durable successful-step result | Lease recovery can replay |
| Later action fails | Earlier send remains successful in history, if results persist | New attempt still replays it |

The message-insert failure comment says not to pretend sending failed, but the implementation does throw, producing a failed automation step.

### What delivery evidence exists?

| Classification | Evidence available today |
|---|---|
| A. Definitely not submitted by this invocation | Validation/preparation failure before the Meta request |
| B. Meta acceptance observed | Returned `wamid`; persisted `messages.message_id`; successful step detail containing the provider ID |
| C. Outcome unknown | Transport failure, response parsing failure, crash, or failure before acceptance evidence is durably recorded |

- Meta acceptance is not proof of delivery to the recipient.
- On the recognized message-insert failure, `wamid` exists in the sender’s local variable but is not included in `AutomationTemplateSendError`.
- The failed step therefore records the error code, not a structured accepted-message identity.
- Existing message records are not linked to a trigger job, attempt, and step.
- Absence of a message row does not prove the message was not sent.

There is no exactly-once delivery guarantee in this implementation.

## 5. Existing Checkpoint Data

| State | Current role | Safe resume checkpoint? |
|---|---|---|
| `steps_executed` | JSON array of step ID, type, status, detail | Useful evidence, insufficient alone |
| `automation_logs` | Attempt history and execution result | Reusable storage, not currently a resume ledger |
| `trigger_job_id` | Stable PMS occurrence identity | Yes, for grouping attempts |
| `trigger_job_attempt_count` | Claim attempt associated with log | Yes, for attempt identity |
| `trigger_job_execution_state` | Processing/completed/failed gate state | Whole-execution protection only |
| Job `status` | Queue lifecycle | No step progress |
| `attempt_count` | Claim count | No step progress |
| `retryable` / `next_attempt_at` | Automatic retry policy | No delivery classification |
| `last_error` | Latest queue failure | Not reliable delivery evidence |
| `processing_started_at` | Lease age | No execution cursor |
| `completed_at` | Queue completion/terminal timestamp | No per-step completion |
| Pending parent/branch/position/context | Wait continuation cursor | Scope-specific resume information |
| `completed_wait_continuation_ids` | Completed continuation segment identities | Segment-level replay protection |
| `messages.message_id` | Provider message identity | Acceptance evidence without step correlation |

`steps_executed` is represented as:

```ts
{
  step_id: string;
  step_type: AutomationStepType;
  status: 'success' | 'skipped' | 'failed';
  detail?: string;
}[]
```

Source: `src/types/index.ts:722`.

Its current limitations are material:

- Successful results accumulate in memory until a scope finishes, fails, or reaches Wait.
- Nested scopes append separately, so array ordering is not necessarily chronological across the tree.
- `appendResults()` performs an unchecked read/merge/update.
- No structured action outcome, action fingerprint, execution stack, or provider ID field exists.
- A step may succeed externally before any corresponding checkpoint is durable.

**Existing storage can be reused, but existing records cannot universally establish a safe resume point.**

## 6. Control-Flow Implications

Execution uses a tree, not one flat sequence:

- Root steps have their own positions.
- Conditions recurse into `yes` or `no` child scopes.
- Child scopes have independent positions.
- Nested conditions are supported.
- Wait stores one scope’s parent, branch, and next position.

Therefore, a global “resume at step N” is insufficient.

### Additional findings affecting resume safety

**Branch decisions can change on retry.** Conditions are reevaluated against current data. Historical `branch=yes/no` exists only as a detail string and is not consulted for replay.

**Nested failure propagation is incomplete.** The parent detects a caught child failure through `args.failure.retryable`. That flag is set for template preparation/template-send errors, but not generic action errors. A generic failed child action can therefore be followed by parent actions and an outer success status.

**A nested Wait suspends its child scope, not the whole parent stack.** The parent can continue with later root actions. The pending row does not store a full return stack.

**Continuation completion is recorded even after caught action failures.** `recordWaitContinuationCompleted()` runs after the execution loop without requiring successful status. Ordinary caught action failures may consequently leave a failed log while the continuation is marked done.

**Wait insertion errors are unchecked.** A returned insert error can still be followed by a successful Wait result and partial status.

**PMS partial status counts as completed acquisition.** A Wait suspension marks `trigger_job_execution_state = 'completed'`; the worker completes the trigger job. Subsequent work belongs to the continuation queue.

**Definitions are mutable.** Retries load current steps. `src/lib/automations/steps-tree.ts:39`, `replaceSteps()`, deletes and reinserts definitions, retaining supplied IDs or generating new ones. Matching only historical step IDs would not detect changed action content.

## 7. Side-Effect Inventory

All current action types were inspected in `src/lib/automations/engine.ts:651`, `executeAutomationStep()`.

| Step type | Classification | Replay implications |
|---|---|---|
| `condition` | Pure/control-flow | Reevaluation can select a different branch |
| `wait` | Wait/scheduling | Replay can enqueue another continuation |
| `send_template` | External, duplicate-sensitive | Another WhatsApp message |
| `send_message` | External, duplicate-sensitive | Another WhatsApp message |
| `send_buttons` | External, duplicate-sensitive | Another interactive message |
| `send_list` | External, duplicate-sensitive | Another interactive message |
| `send_webhook` | External, duplicate-sensitive | Repeats POST; no engine-generated idempotency key |
| `create_deal` | Non-idempotent database mutation | Inserts another deal |
| `add_tag` | Conditionally repeatable | Existing association prevents duplicate add/dispatch; first add triggers other automations |
| `remove_tag` | Generally repeatable | Repeats deletion; may undo intervening changes |
| `update_contact_field` | Generally repeatable assignment/upsert | Can overwrite intervening edits; timestamps change |
| `assign_conversation` | Conditional | Explicit assignment repeats; round robin advances and may choose another agent |
| `close_conversation` | Generally repeatable assignment | Can close a conversation reopened since the earlier attempt |

Interactive sending delegates to existing Flows sender functions in `src/lib/flows/meta-send.ts:346`. These also send before inserting the local message, and post-send persistence errors become ordinary errors.

Text and interactive sends do not have the template-specific terminal classification for known message-insert failures.

## 8. Database/RPC Findings

### Protections already present

`supabase/migrations/57_pms_automation_trigger_jobs.sql:20` provides:

- Unique occurrence keys.
- Additional event/scheduled occurrence uniqueness.
- Account-scoped relationships.
- Atomic claims using `FOR UPDATE SKIP LOCKED`.
- Attempt counters and stale-lease recovery.

`supabase/migrations/71_manual_pms_automation_retry.sql:1` replaces the original single-log-per-job constraint with:

```sql
UNIQUE (trigger_job_id, trigger_job_attempt_count)
```

and adds one completed occurrence:

```sql
UNIQUE (trigger_job_id)
WHERE trigger_job_execution_state = 'completed'
```

These prevent duplicate identities/completed occurrences. They do not enforce action-level uniqueness.

The messages constraint is unique conversation/provider ID (`supabase/migrations/037_webhook_broadcast_reliability.sql:63`). A repeated Meta send obtains another provider ID, so this constraint cannot prevent the second send.

### Manual Retry protections confirmed

`retry_pms_automation_execution()` checks:

- Selected log belongs to the supplied account.
- Log links to the same account/job/automation.
- Job is locked `FOR UPDATE`.
- No completed occurrence exists.
- Job is failed.
- Selected attempt equals the job’s current attempt count.
- Selected log and execution state are failed.
- No processing execution exists for that job.
- Final update still requires account ownership and `status = 'failed'`.
- Worker wake-up occurs in the same RPC transaction.

It preserves history, counters, `retryable`, and `last_error`, while rearming the existing job.

### What these checks do not protect

The RPC does not inspect:

- Successful earlier actions.
- Known accepted-but-not-persisted sends.
- Provider message IDs.
- Unknown external outcomes.
- Definition changes.
- A resumable action path.

The PostgreSQL tests explicitly expect retry to remain allowed after:

- `meta_sent_message_persistence_failed`.
- A successful earlier `send_template`.
- Changed reservation/automation snapshots.

Manual protection against an existing processing log is also stronger than the new-attempt acquisition gate: automatic stale-lease recovery can acquire a later attempt while an older attempt lacks a completed outcome.

## 9. Test Coverage Gaps

### Existing coverage

- Worker backoff, retry classification, and completed-occurrence recovery.
- Same-attempt/completed execution gates.
- Semantic preparation and provider error retryability.
- Template acceptance followed by message-insert failure classification.
- Manual RPC ownership, locking, attempt history, and eligibility.
- Wait scope/position restoration and completed-segment replay protection.

Relevant tests:

- `src/lib/automations/semantic-template.test.ts:413`
- `src/lib/automations/meta-send.test.ts:147`
- `src/lib/automations/manual-retry.pg.test.ts:215`
- `src/lib/automations/engine.test.ts:410`

### Requested scenarios

| Scenario | Current coverage |
|---|---|
| Step 1 succeeds, Step 2 fails, retry skips Step 1 | Missing |
| Template send succeeds, later action fails, retry avoids duplicate | Missing |
| Meta succeeds, message persistence fails | Unit classification covered; full manual replay not covered |
| Automatic retry avoids successful-action replay | Missing |
| Manual retry avoids successful-action replay | Missing; RPC tests explicitly permit requeue |
| Branch resume preserves completed actions and chosen path | Missing; saved Wait scope/position is covered |

Also missing are post-insert conversation exceptions, crashes before progress persistence, stale-lease overlap with an active sender, and failed continuation segments receiving completion markers.

### Tests run

**135 tests passed across seven files:**

- `src/lib/automations/engine.test.ts`
- `src/lib/automations/semantic-template.test.ts`
- `src/lib/automations/meta-send.test.ts`
- `src/lib/automations/pms-worker.test.ts`
- `src/lib/automations/pending-worker.test.ts`
- `src/lib/automations/manual-retry.test.ts`
- `src/app/api/automations/executions/[id]/retry/route.test.ts`

The opt-in PostgreSQL fixture suite was inspected, not run. No live delivery tests were performed and no tests were added.

## 10. Smallest Safe Fix Options

### Option 1 — Conservative replay guard

**Preferred immediate containment.**

Use the existing job/log architecture to reject automatic and manual restart when the occurrence contains evidence of completed duplicate-sensitive actions, known Meta acceptance, or an explicitly uncertain action outcome.

This prevents known dangerous restarts without pretending to implement resume.

**Limit:** today’s missing/batched progress cannot prove safety after crashes. An empty result array must not be treated as proof that no external action occurred.

### Option 2 — Durable action checkpoints using existing logs

Use existing log JSON/state rather than adding a parallel queue or new subsystem:

- Persist each action outcome immediately and check persistence errors.
- Record structured provider acceptance and message ID.
- Preserve tree scope and selected branch.
- Validate action identity/content before reusing a checkpoint.
- Read progress across attempts without rewriting old attempt history.
- Stop rather than replay when definition/path/outcome is uncertain.

This addresses **A: replay of already-completed earlier steps**.

It requires explicit handling of nested branches and Wait behavior; simply skipping successful step IDs is insufficient.

### Separate requirement — Meta acceptance ambiguity

Neither option alone guarantees **B: safe handling of Meta-accepted-but-local-persistence-failed outcomes**.

That boundary needs structured acceptance evidence and an explicit unknown-outcome policy:

- Known accepted: repair local persistence without another send.
- Definitely pre-send failure: retry may be allowed.
- Unknown acceptance: do not blindly resend; require reconciliation or an explicit decision.

A crash between remote acceptance and durable local recording remains an ambiguity window. This audit does not establish a provider idempotency mechanism that closes it.

## 11. Recommended Next Implementation

Implement a small, conservative replay-safety patch first:

1. Prevent automatic/manual whole-execution restart when known successful duplicate-sensitive actions would replay.
2. Prevent manual resend of recognized accepted-but-persistence-failed template sends.
3. Preserve accepted provider IDs in structured existing execution state.
4. Check progress-persistence failures and treat uncertain outcomes conservatively.
5. Add the missing replay and acceptance-boundary tests.

Then implement resume using the existing engine, logs, and queues, with explicit branch/Wait semantics and definition validation.

**Do not ship a “resume at step N” patch or claim exactly-once delivery. Current retry is whole-attempt restart; current Wait resume is scope-level continuation. Neither is a durable per-action replay guarantee.**
