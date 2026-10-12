# WhatsApp connection deletion and settings dialogs

12 October 2026.

The live CRM project now has migration 79 applied. Read-only inspection found both a conversation and a template that would collide when deleting a connection: the foreign keys set `whatsapp_config_id` to NULL, but the legacy unlinked-row unique indexes reject matching historical rows.

Migration `80_whatsapp_connection_delete_history.sql` converts those two unlinked indexes to ordinary lookup indexes. It keeps every historical conversation, message and template separate, preserves the existing active-connection unique indexes, and leaves the authorized atomic deletion/primary-promotion function unchanged. Unlinked historical rows can now coexist after multiple numbers are removed. No data merging, new tables or authorization bypass is introduced.

The settings page now shows connection cards or the empty-state action. Add opens Embedded Signup in a responsive, scrollable modal; Advanced Options switches to the existing manual setup wizard. Manage opens only the selected connection in another modal, and Done closes it. Workspace switches close open setup/manage dialogs. The existing Base UI dialog handles modal focus, keyboard dismissal and background interaction. Management dismissal is disabled while saving or deleting.

Validation: the old deletion failure reproduced on disposable data. Clean migrations 001–80 replayed successfully; schema/security assertions passed. All 49 PostgreSQL tests passed, including preservation of colliding historical rows and atomic primary replacement. All 75 relevant settings, signup and config API tests passed, with no skipped tests in these runs. TypeScript, changed-file lint, the production webpack build and diff checks passed.

Apply migration 80 to `ideibnrtszjdrxsusnwc`, then deploy the updated application. Do not reapply or edit the already-applied migration 79. No live connection was deleted and no remote migration was applied by this task. Browser verification of the deployed dialogs remains pending deployment.
