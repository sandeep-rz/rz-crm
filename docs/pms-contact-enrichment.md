# PMS contact enrichment and recovery

## Existing flow and what was missing

Rukiye Zara creates reservation domain events in Postgres. Its existing outbox
fans them out to subscribed webhook endpoints and retries delivery. The CRM
authenticates and deduplicates each receipt, then fetches the current reservation
from the provider API. Initial sync, webhook processing and reconciliation share
the same reservation projection. Only the webhook path creates reservation
event occurrences; reservation timing jobs and Wait continuations use their
existing workers and database claims.

There were three gaps:

- PMS native and OTA host edits could update the host's guest profile without
  changing the reservation view or creating an outbox event. The OTA booking
  event predicate also ignored contact-only changes from its source.
- CRM enriched contacts before fencing stale reservation snapshots. Its
  enrichment only filled empty fields, so corrections could leave an old
  recipient in use. A later snapshot without identity data could also drop
  the reservation's contact link.
- WhatsApp steps treated a missing recipient as a failure. Wait continuations
  retained a snapshot of the previous contact, and replaying an entire failed
  run could repeat an earlier side effect.

## Behavior

The PMS migration and API change expose authorized host edits in the canonical
CRM reservation API and send the existing `reservation.updated` event. Native
profile changes emit updates for current/upcoming reservations; older native
reservations can pick up the updated snapshot through reconciliation. OTA
booking changes still use the existing event emitter and its confirmation and
cancellation keys. The webhook contains no guest contact details.

The provider adapter supplies a stable external reservation ID, a monotonically
advancing `updatedAt` for changed snapshots, and optional guest data.
`guest.clearedFields` identifies deliberate clears; an absent, blank or null
value on its own preserves the last known field. Phone inputs must include an
international country code (`+` or `00`). Account-scoped matching uses a stable
guest mapping or the linked contact, a normalized phone and then an unambiguous
non-relay email. A phone already assigned to another account contact reuses
that contact instead of creating a duplicate. An account lock serializes PMS
match/create; the contact, identity and reservation updates commit together.
Reservations keep their CRM ID, original creation timestamp and existing
occurrences. Repeated confirmation receipts for the same reservation and
automation cannot create another confirmation job.

The engine parks only at a contact-dependent step, before a WhatsApp request
or its delivery latch is started. The checkpoint retains the original due
time, step ID, prior results and original job identity. An already running Wait
keeps the same continuation row and attempt count when it parks. The existing
Wait cron claims recovered cursors using its usual lease. It refreshes the
reservation and recipient, rechecks trigger and connection eligibility, and
resumes from the saved step. Steps already recorded as successful are skipped,
including steps moved after the cursor while it was parked. Meta acceptance
and ambiguous outcomes retain the existing retry guards; they never enter
contact recovery. Previously failed terminal jobs are not reopened.

A contact sync can wake parked rows for its reservation immediately. The
existing Wait worker also checks a bounded, indexed batch of blocked rows on
each tick, including contacts corrected directly in CRM. Suppressed or expired
cursors stay terminal and keep their step history. The default deadline is 24
hours from the original job or Wait due time. Set
`PMS_CONTACT_RECOVERY_EXPIRY_HOURS` to an integer from 1 to 720 before deploying
the CRM to change the deadline for newly parked work. Waiting for contact
does not consume retry attempts; the existing continuation retry limit applies
when workers claim a ready or stale continuation.

## Deployment

1. Apply the CRM migration
   `20261110150615_pms_contact_enrichment_and_recovery.sql` after existing CRM
   migrations. Deploy the CRM workers and app.
2. Verify the existing authenticated CRM Wait cron calls
   `GET /api/automations/cron` regularly (once per minute is suitable). It
   requires the configured `AUTOMATION_CRON_SECRET` in `x-cron-secret`.
3. Apply the PMS migration `20261110151224_rz_crm_reservation_guest_contact.sql`,
   then deploy `rz-api`. This order ensures the guest edit marker and CRM view
   exist before the API starts using them.
4. Verify the managed PMS endpoint subscribes to `reservation.updated` on
   each property that should sync guest changes promptly. Keep the current
   credentials, signing secret, worker schedules and outbox retry settings.
   In DEV, confirm an edit produces one outbox delivery and wakes the same
   blocked occurrence. Use a controlled WhatsApp test recipient for the final
   provider test.

The CRM SQL assertions are in `supabase/tests/pms-contact-recovery.sql`.
Run them against a disposable database with the migrations loaded. They
exercise enrichment, versioning, tenancy, expiry, cancellation, confirmation
dedupe and queue claims. The automation engine tests also cover preserving
earlier steps and keeping the accepted or uncertain Meta send guard.
