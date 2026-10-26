# Simple WhatsApp setup: one connection per workspace

26 October 2026.

## Host experience

- No saved, recover or discard setup screens. Closing or cancelling setup starts fresh next time. The old discovery hook and its saved-attempt UI were removed; the compatibility GET returns an empty list, and obsolete recover/discard actions are rejected.
- Add WhatsApp is available only when the workspace has no connection. The API and a transactionally locked database trigger also reject additional connections, including concurrent non-primary inserts.
- Manage shows connection status, the number, Open inbox and a short history-import status. Reconnect appears only when the connection needs attention and uses that connection's existing onboarding mode. Technical credentials and diagnostics are under one collapsed Advanced settings section. Manual setup remains available for the initial connection.
- Existing multi-number workspaces retain their records and can maintain/reconnect existing numbers; they cannot add another. The underlying connection, Inbox, messaging and automation infrastructure remains unchanged.

## Session handling and safety

Setup needs a short-lived server nonce and encrypted authorization while the Facebook popup is active. These are not saved setups available to hosts. Modal close/cancel and page exit automatically request cleanup. Starting again also cleans the same user's abandoned attempts. If the browser terminates before sending cleanup, the existing maintenance job clears expired attempts after the normal ten-minute nonce lifetime; failed or interrupted activations are cleaned once their processing lease ends.

Ordinary abandoned attempts and credentials are deleted. Unused disconnected signup placeholders are removed so a fresh setup can proceed. Working connections and active server activation are protected. If Meta registration may already have happened, only its existing minimal safety tombstone remains; authorization/access tokens and PINs are cleared. This marker cannot be resumed and prevents unsafe repeat registration. No new tables, workers, queues or dependencies were introduced.

## Rollout

Apply `84_whatsapp_simple_single_connection.sql` after existing migrations, then deploy the matching application. The migration uses the repository's existing numeric sequence. It clears old idle unfinished setup data without deleting established connections or interrupting active activation. The shared private functions keep their service-only privileges; client authorization and RLS are unchanged.

No remote migration, deployment or real Meta operation was performed by this task. The owner remains responsible for applying and deploying, as previously requested. Verify one actual fresh signup, close/reopen, reconnect, and manual connection after deployment.

## Validation

- Clean migration replay through 84 succeeded on disposable Supabase PostgreSQL 17, with schema/security assertions passing.
- All **49 existing PostgreSQL tests passed against migrations 001–83**, verifying retained connection, coexistence and history infrastructure before the temporary policy is enabled.
- All **8 new PostgreSQL policy tests passed against migration 84**, none skipped: concurrent non-primary inserts, cross-workspace isolation, standard/manual updates, legacy connection maintenance, abandoned authorization/placeholder cleanup, working-connection protection, uncertain-registration barriers, expired maintenance cleanup and restricted privileges.
- WhatsApp, setup, config API and automation regressions: **1,153 passed, 120 optional tests skipped**. Database suites were run separately as described above; other optional suites were not claimed to pass.
- TypeScript, changed-file lint, production webpack build and diff checks passed. A malformed stale generated development route-types cache was refreshed from Next's regenerated current route types; no source workaround was introduced.
- Deployed browser/Meta E2E verification remains pending rollout.
