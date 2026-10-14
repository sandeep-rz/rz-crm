# Permanent chat deletion

Admins and owners can delete a chat from its inbox header after typing `DELETE`.
The chat and its message rows, reactions and conversation notifications are
physically deleted. The contact, connection, deals, reservations, templates and
other conversations stay. Deals lose only their link to the erased chat.

Pending automation continuations tied to this conversation are stopped. Idle
active flows are ended with `conversation_deleted`. Deletion refuses active
webhook leases, running continuations and recently advancing flows instead of
racing their replies. A new inbound message opens a fresh conversation. Delayed
ordinary deliveries and Coexistence history at or before deletion are suppressed,
including the check/insert race for durable deliveries.

A private deletion marker retains account/contact/connection IDs and the cutoff
without message text. File URLs stay only while Storage cleanup is pending. This
is replay protection, not a recoverable chat or trash folder. Existing independent
flow and automation audit records are preserved.

## Attachments

Only account-owned uploads in this project's `chat-media` bucket are candidates.
Surviving messages, templates, quick replies, flow definitions/runs, automation
steps/continuations and broadcasts are checked immediately before removing a
file through the Supabase Storage API. Referenced files stay because those
features still need them. External URLs, Meta-hosted media, other buckets and
ambiguous legacy paths stay. No SQL deletion of `storage.objects` is used.

The DELETE endpoint processes up to 25 URLs per request. Storage failures do not
undo or misreport the committed chat deletion. Pending cleanup stays durable and
is retried through the existing authenticated WhatsApp worker, with bounded
batches and its remaining runtime budget. The confirmation UI also offers an
immediate retry. The existing worker schedule must be enabled for automatic
recovery. Storage reference checks and configuration writes are separate
transactions; attaching an old URL to a configuration during cleanup is not
serialized. Already dispatched WhatsApp sends cannot be recalled.

## Deployment and validation

Apply `supabase/migrations/82_permanent_conversation_delete.sql` before deploying
the code. The migration intentionally removes direct authenticated DELETE rights
on conversations; the admin-checked RPC is the deletion path. New webhook guards
also require this migration. No hosted migration, real chat deletion or push was
performed during implementation.

Validation passed: 2,308 application tests, 8 PostgreSQL deletion tests using
this migration and the actual history importer, TypeScript, production build
with Webpack, and `git diff --check`. Changed-file lint has zero errors and two
existing warnings in `message-thread.tsx`. The default Turbopack build was
blocked by the environment's local-port restriction; the Webpack build passed
with dummy service settings. Live hosted RLS/Storage/Realtime and end-to-end Meta
behavior still require staging verification.
