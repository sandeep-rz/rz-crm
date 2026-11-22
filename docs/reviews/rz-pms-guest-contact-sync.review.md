# Guest contact synchronization — corrected review draft

The owning migration is `../migrations/20261110151224_rz_crm_reservation_guest_contact.sql`.
It replaces the previous **unapplied** draft. Do not apply it to a connected
project before review. Tests apply it only to named disposable local databases.

## Effective data and priority

Guest values remain in `pms_users`. No new tables, contact snapshots, parallel
views, queues, or sending engines are introduced. The existing reservation view
reads the same-host linked profile, including NULL values. It does not restore
an intentionally cleared field from `users` or a stale OTA snapshot.

`contact_provenance` is metadata per field (`name`, `email`, `phone`):

- No key: the existing source upsert may accept a valid, nonempty source value.
- `host`: a host supplied the value; source synchronization cannot overwrite it.
- `cleared`: the host explicitly removed it; source synchronization cannot refill it.
- `legacy`: origin is unknown; retain it conservatively pending ownership review.

Legacy ownership protects a field only while that field has a nonempty value.
An empty legacy tag cannot block valid source enrichment; once enriched, that
obsolete tag is removed so the value remains source-owned. Blank/missing/invalid
source phone/email values are treated as absent, never as clear instructions.

Both OTA and native account-to-profile source writes use the same explicit
priority checks in `upsert_pms_user_from_booking`. Host RPCs mark the fields they
actually write. There is no use of `pg_trigger_depth()` to classify a writer.
Notes, last-seen bookkeeping and ownership-only changes without clear-intent changes do not advance the contact version or emit an event.

## New schema metadata

| Column                                  | Purpose                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bookings.pms_user_id`                  | Native equivalent of the OTA reservation's existing stable profile link. Indexed; same-host assignments are checked.                                 |
| `pms_users.contact_provenance`          | Field ownership and explicit-clear intent only; no guest values duplicated.                                                                          |
| `pms_users.contact_updated_at`          | Monotonic effective contact version, including explicit-clear intent.                                                                                |
| `bookings.guest_contact_updated_at`     | Versions a native link/relink and fences context changes independently of booking business timestamps.                                               |
| `pms_bookings.guest_contact_updated_at` | The equivalent OTA link/context fence, including relinks to unchanged profiles.                                                                      |
| `domain_events.contact_sync_txid`       | Identifies new events in the current transaction so contact fanout can reuse an existing booking event. Historical events remain NULL and unchanged. |

The existing OTA profile-reference index and a new native equivalent bound
profile lookups/fanout. A partial transaction-event index bounds event coalescing.
No full-reservation-table reconciliation scan is added by the contact layer.

## Trigger changes

- `version_pms_guest_contact` stamps only effective value/clear-intent changes.
  Its version is newer than the profile's old version and every linked reservation
  source/link version. It never guesses the writer's origin.
- `zz_version_native_guest_link` and `zz_version_ota_guest_link` validate and
  version links, including changes assigned by a BEFORE source trigger. Native
  identity or cross-host listing reassignment detaches the old profile; a same-host listing move retains it. Parent profile deletion
  is recognized by the missing FK target, rather than trigger depth.
- `fanout_pms_guest_contact` is deferred until commit. It reads final links and
  publishes every affected active native/OTA reservation. Active means not
  cancelled and not checked out before today in the property's timezone.
- `publish_native_guest_link` and `publish_ota_guest_link` are deferred link
  publishers, including relinking to a profile whose own values did not change.

The existing source profile triggers and native directory upsert remain in
place. Native directory synchronization retains its profile ID on the booking;
that narrow trigger runs with a fixed search path under its owner so a valid
booking creation does not require a second, unrelated edit permission.

Reservation context writers take a shared lock on the linked profile before
minting their projection version. This serializes a business update behind a
concurrent host contact write, even when its ordinary `updated_at` was computed
at the start of an older transaction. The metadata fence advances when a
business context changes without a newer business timestamp, preventing the
contact clock from hiding a later booking change.

Deferred contact publishers never UPDATE reservation rows or take their row
locks. A source writer holding a booking lock while waiting for a profile can
therefore finish without the profile fanout taking the reverse lock order.

## Versions and existing events

The existing view exposes the maximum of business update, link update and
profile contact update as `reservation_updated_at`. Booking `created_at`,
`updated_at`, `confirmed_at`, `booking_date` and OTA `last_revision` are not
rewritten for contact synchronization.

`emit_domain_event` uses that same effective source version for a new reservation
event's `occurred_at` and `data.source_updated_at`. At commit, contact publishers
refresh an existing lifecycle event **created in this transaction** if there is
one. Its ID, type, key and delivery stay intact. Otherwise they use the existing
emitter to create one `reservation.updated` per effective version. Multiple
contact changes/link operations within that transaction reuse the event; old
committed events and deliveries are not rewritten. Independent business events
already produced by the existing system are preserved, not deleted or merged.

The outbox worker reads the final committed event. Its current DEV implementation
passes `ctx.occurred_at` through without a JavaScript Date conversion. PMS API
cursor/watermark parsing and CRM event receipt now retain PostgreSQL microseconds.
Projection versions are independent of which contact fields the caller may
view. Effective private values remain permission-masked; the CRM service sees
the full authorized profile. The CRM scan watermark stays at the scan start,
rather than its later finish.
The durable outbox remains the recovery path for transactions that commit after
an incremental scan has passed their rows.

## Shared guests and native edits

A directory profile is shared by design. A confirmed guest-wide edit therefore
updates every linked reservation's effective contact. Only active reservations
receive contact update events; past/cancelled booking rows and their business
state/timestamps are not modified.

`update_rzr_booking_guest_contact` refuses a change affecting other reservations
unless `p_update_shared_profile=true` was explicitly supplied, and then checks
edit permission on every related reservation. It does not silently fork a
profile, retarget an already linked booking, overwrite a guest account identity,
or modify the shared profile on a rejected request. Saving matching values records host ownership without advancing the effective
version or rewriting hidden name components. A repeated protected save is a no-op.

The native endpoint accepts `update_shared_profile` and returns a structured 409
when consent is needed. **Web/mobile still need to present that confirmation and
resubmit the flag before shared native edits can be enabled for users.** The
safe default is refusal, not an implicit change to other bookings.

The existing OTA update/link RPC permissions, identity conflict responses and
host match checks remain. When linking adopts a host/historical name from the provisional profile, its
ownership travels with that adopted name. Provisional cleanup also checks native references, so
linking the last OTA stay cannot delete a profile still used by a native booking.

## Historical ownership and deployment tradeoffs

Existing fields have no trustworthy per-field author history. The migration
labels only nonempty values `legacy`: name checks full/first/last components,
email checks trimmed text, and phone checks raw/normalized values. NULL and blank
fields get no ownership key and remain eligible for future OTA enrichment.
No explicit-clear flags are invented. Review and selectively remove legacy ownership keys from
known source-owned nonempty fields before expecting OTA corrections there.
Ownership-only changes do not send guest update events; subsequent effective
source changes do. New source-created profiles start source-owned normally.
Older intentional clears cannot be distinguished from never-supplied NULLs.
They require an explicit host replay to establish protected clear intent; this
backfill deliberately leaves unknown missing values enrichable.

The migration mints a newer contact version for existing profiles so normal
reconciliation can find missed historical edits. It does not retroactively
create booking events. Existing native links are backfilled only from a unique
same-host last-seen association. Missing older associations whose moving pointer
was replaced need review or a subsequent authorized host edit; names/emails are
not used for speculative migration matching.

A shared profile is not a per-stay historical snapshot. An expressly approved
shared edit can change the contact displayed for old linked stays, as under the
existing directory model. Per-stay independent contacts would be a separate
product/storage decision and are not added here.

Review/apply the SQL before deploying the updated API. Deploy the companion CRM
precision/watermark changes and the existing generic enrichment/recovery work
through the normal release workflow. Keep the current property subscriptions,
webhook credentials, signing secret, worker and cron configuration. No external
service, hosted migration, provider message or deployment was changed during this review.

## Tests

`run-guest-contact-tests.sh` resets **only** `rz_contact_v3_test` and
`rz_contact_history_test` on a supplied `/tmp/rz-*` Unix socket at port 55452.
It loads a small schema fixture containing the captured pre-migration owning
functions, applies the draft there, and runs the real database transitions.
Permissions are simulated with test role/host settings; this is not a hosted
production clone or a live provider test.

```bash
RZ_CONTACT_PG_SOCKET=/tmp/rz-your-disposable-server \
  bash apps/rz-api/supabase/tests/run-guest-contact-tests.sh
```

Coverage includes absent OTA phone, late host phone, nonempty stale OTA values,
missing source fields, duplicate payloads, all active shared reservations,
clears (including already-NULL clears), coalesced booking/confirmation events,
native shared consent, guest linking/native-reference cleanup, cancelled/past
stays, authorization, concurrent host/OTA and business writers, permission-independent versions and microsecond cursor equality.
Historical assertions verify existing values, timestamps and event IDs/keys/data
are unchanged and legacy contact versions advance beyond even future source clocks.

The CRM repository's `contact-sync.pg.test.ts` additionally runs the actual PMS
API normalizer, CRM provider adapter and SQL enrichment RPC against separate
fixture databases. It checks stable reservation/contact identity, outbox coverage,
explicit clearing, stale snapshot rejection and two updates only one microsecond
apart in the same JavaScript millisecond. Use the CRM test-only fixture setup
script after the PMS suite; no hosted URL or credential is accepted.

## Focused follow-up: missing historical fields

Web PMS and mobile OTA edits both use `buildPmsBookingGuestUpdates` →
`update_pms_booking_guest`; it includes clear strings and omits untouched fields.
Their existing-guest linking flows use `link_pms_booking_to_existing_guest`, which
applies entered fields through the same update RPC. Native web/mobile edits call
`/bookings/:id/guest-profile` → `update_rzr_booking_guest_contact`; its supplied
values establish host/clear ownership. No application path directly updates
`pms_users`. The previously documented native shared-confirmation UI prerequisite
still applies; this follow-up does not change that product flow.

Latest local database verification: 22 PMS transition cases plus real pre/post
backfill historical assertions, and 4 PMS-to-CRM integration cases passed. Coverage
includes NULL/blank historical phone enrichment, preserved nonempty history,
empty legacy metadata, host-added values, explicit clears, linking provenance,
multiple shared stays, blank/invalid OTA input, and duplicate retries.
The CRM case runs the actual reconciliation loop against SQL-backed synchronization
and verifies one pending existing-outbox delivery per affected reservation with
exact projection/event source-version equality. No provider HTTP request is sent.
