# Step 5B — Semantic automation sending

Implemented 2026-10-07. **Implementation complete; production readiness NOT verified.**
No migrations, API version changes, provider credential changes, DEV data edits, or real messages were made. Broadcasts, Flows, manual/public sends, AiSensy, and MSG91 retain their execution paths.

## 1. Existing Reservation Confirmed flow

The existing PMS webhook processing/synchronization supplies the canonical CRM reservation identity to `schedulePmsReservationAutomations`. `pms-scheduler.ts` maps `reservation.confirmed` to `reservation_confirmed`, evaluates property filters, and inserts one durable occurrence per matching automation into `automation_trigger_jobs` using `occurrence_key` conflict suppression.

`pms-worker.ts` reloads the current account-scoped reservation, checks automation eligibility and current reservation state, and dispatches `runAutomationForTrigger`. The existing `begin_pms_automation_execution` RPC protects the claimed execution identity and reservation version. The existing engine executes the step tree and writes `automation_logs`.

## 2. Canonical reservation identity

`automation_trigger_jobs.pms_reservation_id` becomes `job.reservationId`, which loads `loadReservationAutomationContext`. That projection sets `reservation_id` from `pms_reservations.id`. The worker supplies it in `context.reservation`. The semantic step takes **only** `args.context.reservation.reservation_id` for preparation.

External booking IDs, contact IDs, property filters, phone numbers, cached vars, and action-level IDs never select semantic reservation context. Missing canonical context fails before preparation or Meta sending.

## 3. Semantic versus legacy discriminator

A defined `step_config.template_id` selects semantic execution, including invalid/empty identities that must fail rather than fall back. An action without that field retains legacy positional variables or legacy variable mappings. A selected semantic action never invokes the old `buildAndResolveMessageVariables` path.

## 4. Template authority

`template_id` identifies the account-scoped template loaded by existing Step 5A. Preparation checks ownership, sendability, approval, configuration, connection ownership, and mapping/content consistency. Prepared name, explicit language, mapping, runtime values, and connection are authoritative. Stale action `template_name`, `language`, `variables`, and `variable_mappings` are ignored.

Activation validation requires a valid template UUID for semantic actions and does not require the legacy name/mapping. Legacy validation remains intact. `template_name` is now optional in `SendTemplateStepConfig`.

## 5. Recipient and reservation remain separate

`contactId` remains the engine's recipient identity. The existing sender loads that account-owned contact and uses `resolveContactSendTarget` for its phone or business-scoped user ID. Semantic contact variables come from the reservation-driven runtime resolver and never replace recipient addressing.

## 6. Template connection and conversation

The prepared template's `connectionId` is explicitly passed to existing `resolveWhatsAppConnection`, overriding automation/conversation/primary preferences. Conversation lookup is scoped to account, recipient contact, and this connection. Missing conversations use existing `resolveConversationForContact`; an incoming conversation on another connection is not reused.

The existing sender receives the same explicit connection ID and uses that configuration's phone-number ID and decrypted token. A disconnected semantic connection blocks sending. Existing contact/conversation account checks remain.

## 7. Reused Step 5A calls

Each semantic action calls exactly once:

```ts
prepareTemplateMessage({
  accountId: args.automation.account_id,
  templateId: cfg.template_id,
  context: { reservationId: args.context.reservation.reservation_id },
});
```

Preparation is late bound and continues to use one bulk Step 4 provider request for unique provider-owned keys. No new resolver, cache, fallback, or approval-sample path exists. Server-only preparation modules load only when the semantic branch executes.

## 8. Meta payload assembly

The engine calls existing `buildMetaTemplateMessagePayload(prepared)` once. Its existing assembler preserves numeric occurrence positions, repeated semantic keys, component ordering, and explicit language. The resulting template portion is passed to the existing Meta API client without legacy component reconstruction or sample/default substitution.

## 9. Existing Meta sender

The path is `executeAutomationStep` → `engineSendTemplate` → existing `sendViaMeta` → `sendTemplateMessage` → existing Graph `/messages` transport. The client accepts an optional assembled `templatePayload`; callers without it retain the old transport construction. Graph version remains unchanged.

## 10. Preparation failure behavior

`TemplatePreparationError` remains typed through execution. Missing/unsupported values, invalid mappings, unconfigured/unapproved/foreign templates, and unsupported components block all Meta calls. Safe log details include error code, canonical variable key when present, and provider failure code/HTTP status. Resolved values, approval examples, raw provider bodies, and credentials are not logged.

## 11. Retry classification

The engine carries typed retryability in `AutomationExecutionResult.retryable`; the PMS worker uses it instead of unconditionally retrying failed semantic execution. Existing legacy failures keep the prior default. No schema is required.

- Missing/unsupported/mapping/ownership/sendability failures: terminal.
- Step 4 timeout/5xx: retain Step 4's retryable classification.
- Provider auth/authorization failures: retain Step 4 metadata; never reclassify as a missing variable.
- Meta 429/5xx: retryable. Other structured Meta HTTP failures: terminal.
- Invalid credentials/disconnected/unaddressable recipient: terminal; database lookup failures remain retryable.
- Known Meta success followed by returned message-insert error: safe `meta_sent_message_persistence_failed`, terminal, avoiding automatic resend of a known accepted message.

Nested semantic failures propagate to the parent run and stop subsequent actions.

## 12. Existing idempotency

Occurrence-key deduplication, worker claims, completed-execution detection, and the existing RPC's `already_completed`/`already_running` suppression remain. Tests verify these dispositions perform no preparation or send. A successful action makes one call to the existing sender. There is no new semantic retry loop; the existing sender's recipient-not-allowed phone-variant behavior remains.

## 13. Delivery limitations

This is **not exactly-once delivery**. The current RPC resets `steps_executed` when acquiring a new attempt of a failed run. Earlier successful actions may therefore rerun if a later action fails. A process crash or uncertain transport response after Meta accepts a message but before message/run persistence can still result in a duplicate on retry. The HTTP send and database records have no shared transaction or Meta idempotency key.

The terminal known-insert-error classification reduces a known resend case, but is not a durable crash-recovery mechanism. No new queue, delivery ledger, or migration was introduced.

## 14. Persistence

Successful semantic sends use the existing `messages` insert with conversation ID, bot sender type, template content type/name, substituted positional body, actual provider message ID, and `sent` status. Existing conversation timestamps/preview updates and engine step/run persistence remain. Conversation membership supplies the selected connection association; messages do not gain a new connection column. Subsequent delivery/read status continues through existing webhook infrastructure.

Semantic body persistence uses the prepared template and resolved BODY positions, avoiding a second name/language template lookup. No resolved-variable snapshot or parameter cache is stored.

## 15. Legacy compatibility and other reservation events

Actions without `template_id` retain legacy numeric-variable interpolation and mapped-variable execution. Existing automation, Meta, recipient, media, template-builder, and persistence-related tests pass. Shared canonical reservation context naturally supports other reservation triggers, including timing triggers, with no additional worker or scheduling changes. Non-reservation semantic actions without canonical context fail instead of guessing a reservation. Broadcasts, Flows, and manual sends were not migrated.

## 16. Modified files

| File                                                 | Change                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/automations/engine.ts`                      | Semantic branch, explicit conversation connection, safe failure diagnostics and retry propagation; export existing step boundary for DEV verification |
| `src/lib/automations/meta-send.ts`                   | Accept assembled payload/prepared identity, explicit credential connection, semantic body persistence and safe terminal errors                        |
| `src/lib/automations/pms-worker.ts`                  | Honor execution retryability                                                                                                                          |
| `src/lib/automations/validate.ts`                    | Authoritative semantic identity validation; preserve legacy requirements                                                                              |
| `src/types/index.ts`                                 | Optional legacy name on semantic action configs                                                                                                       |
| `src/lib/whatsapp/meta-api.ts`                       | Accept assembled template portion without rebuilding components                                                                                       |
| `src/lib/automations/template-send-error.ts`         | Small safe execution error type                                                                                                                       |
| `src/lib/automations/semantic-template.test.ts`      | Branch, authority, context, assembly, failures, retries, gate, nested failure and log tests                                                           |
| `src/lib/automations/meta-send.test.ts`              | Existing sender credential selection, recipient, message persistence and legacy tests                                                                 |
| `src/lib/automations/pms-worker.test.ts`             | Worker retry classification tests                                                                                                                     |
| `src/lib/whatsapp/meta-api.semantic.test.ts`         | Actual HTTP body assembly test using mocked fetch                                                                                                     |
| `src/lib/automations/semantic-template.live.test.ts` | Opt-in real DEV read-only preparation through actual step branch                                                                                      |
| `docs/semantic-automation-sending.md`                | This implementation/verification report                                                                                                               |

## 17. Executed verification

Using the bundled Node runtime:

- Focused automation, Step 5A preparation, Step 4 resolver, semantic template/Meta/WhatsApp, and builder suites: **839 passed; 3 opt-in live tests skipped**.
- Full suite: **1,733 passed; 6 failed; 3 opt-in live tests skipped**. All failures are the existing `src/i18n/messages.test.ts` Korean/Portuguese/Spanish key-parity and invalid-ICU placeholder failures; no new suite-import failures remain.
- Typecheck: passed.
- Scoped ESLint over changed TypeScript files: passed.
- `git diff --check`: passed.
- Webpack build: blocked by installed `lucide-react` missing `dist/esm/icons/building-complex.mjs`, as previously observed. Build success is not claimed.

Logs for this run are under `/tmp/rgcrm-step5b-focused-final.log`, `/tmp/rgcrm-step5b-tests-final.log`, and `/tmp/rgcrm-step5b-build.log`.

## 18. Real DEV dry-run

Ran `RGCRM_SEMANTIC_AUTOMATION_DEV_TEST=1 ... vitest run src/lib/automations/semantic-template.live.test.ts`.

The test selected a real DEV-connected workspace, real connected reservation/contact, and approved configured text-only RGCRM template. It exercised the actual engine step branch and real Step 5A/Step 4/PMS resolution. Credential/conversation creation and the sender boundary are mocked; the fetch guard permits only CRM reads and the DEV PMS bulk-resolution endpoint. It cannot send Meta requests or write CRM data.

**Blocked before payload assembly/send:** `variable_missing`, canonical key **`property.staff_details`**, `retryable=false`. This is a source-data prerequisite failure, not a successful end-to-end compatibility test. No fallback was inserted.

A separate read-only inventory confirmed exactly one approved configured RGCRM template in DEV-connected workspaces: `booking_confirmat`, `en_US`, no media header, requiring `contact.first_name`, `listing.name`, check-in/check-out dates, and `property.staff_details`. No suitable alternative approved template was available. Data was not changed to force the test to pass.

## 19. Real DEV send

**NOT PERFORMED.** The mandatory successful dry-run prerequisite failed. No recipient was used for actual delivery; a known authorized test recipient and live credential/send/message persistence would still need verification after preparation succeeds.

## 20. Remaining blockers

1. Populate the legitimate DEV property's `property.staff_details` source value for the selected reservation, or provide another approved configured semantic template whose required real source values exist. Do not use preview/sample fallbacks.
2. Rerun the opt-in dry-run to completion, then verify one controlled text-only send to a known test recipient through the actual existing sender and persistence path.
3. Repair the existing missing lucide dependency module before a successful release build. Existing translation failures remain separate.

## 21. Production readiness

**NOT READY TO CLAIM PRODUCTION VALIDATION.** The semantic execution path is implemented and its focused regression checks pass. Real preparation is appropriately blocked on missing DEV source data, and real Meta delivery/credential/persistence verification has not occurred. The existing at-least-once crash/retry limitations remain explicit. No production or DEV messaging side effects occurred during this work.
