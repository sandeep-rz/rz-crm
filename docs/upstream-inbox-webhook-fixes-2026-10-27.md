# Upstream Inbox and webhook fixes

Integrated on `codex/upstream-inbox-webhook-fixes`, based on `73a0ef9`.

| Upstream commits     | Integrated behavior                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6651727`, `621a052` | Incrementally cap webhook bodies and compare shared/legacy verification tokens through SHA-256 plus constant-time comparison. Retain RZ's 4,000,000-byte ledger limit, signature validation and capture-before-acknowledgement pipeline. |
| `b02b4f4`, `140e439` | Give the mobile composer more writing space; Enter inserts a line on touch devices. Fine-pointer Enter sends, Shift+Enter inserts a line, and IME composition does not send.                                                             |
| `07fc8bc`            | Show template headers, footers and button labels in Inbox. Adapted to RZ semantic preparation with a frozen display snapshot of the actual send, connection identity and language.                                                       |
| `278c874`            | Return 404 when an automation DELETE matches no record in the caller's account.                                                                                                                                                          |

## RZ adaptation and preservation

Template snapshots use existing template preparation, send paths and the atomic outbound RPC; they do not rerun legacy send validation or store the full resolved contact/reservation context. Media IDs use the existing authenticated, connection-scoped media route. The display-only button labels are not outgoing interactive actions.

Legacy messages without snapshots use only an unambiguous template name/body match within the conversation's WhatsApp connection; ambiguous language variants are not guessed. Their original parameterized headers cannot be reconstructed. New snapshots preserve the sent display when the catalog changes.

PMS integration, Coexistence metadata and signup, durable delivery/unknown-outcome protection, semantic template preparation, exact-ID optimistic acknowledgements, prior migrations, theme and reservation filters are retained. No paths were deleted. Metrics/dashboard and wait-for-reply changes are outside this batch.

## Deployment prerequisite

Apply `supabase/migrations/87_template_message_snapshot.sql` through the normal migration workflow **before deploying the application**. It adds `messages.template_snapshot` and replaces the existing atomic outbound function to persist the optional field. Existing callers without snapshots remain supported. This work did not apply any migration to hosted Supabase or deploy anything.

## Validation

- Application suite: 226 files passed; 2,564 tests passed, 158 skipped (environment-gated suites).
- Migration 87 applied only to disposable local PostgreSQL database `rz_inbox_outbound_test`; eight actual SQL tests passed for atomic storage, agent handoff, duplicate replay/read-status preservation, foreign-account rejection, role restrictions, old callers, non-template messages and reply scope.
- The isolated SQL fixture is a minimal schema for the affected contract, not a full production-schema replay. Fixture: `src/lib/test-fixtures/outbound-snapshot-schema.sql`; opt-in test: `RZ_INBOX_PG_TEST=1 … vitest run src/lib/outbound-snapshot.pg.test.ts`. The test requires the marked disposable database on `/tmp/rz-upstream-pg-socket`, port 55447.
- TypeScript check, ESLint on all changed TypeScript files, formatting and production build passed. Build used placeholder Supabase configuration; no live Meta message was sent and no live-account/browser QA was performed.
