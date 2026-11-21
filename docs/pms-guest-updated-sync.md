# guest.updated integration — staged, not deployed

## Scope
- PMS already emits one property-scoped `guest.updated` webhook per guest contact update.
- CRM accepts and queues `guest.updated` using the existing signed webhook receiver.
- CRM's existing worker handles guest events separately from reservations and **does not schedule reservation automations**.
- Only an existing `pms_contact_external_identities` mapping with a reservation at the event's property can be updated. No fuzzy email/phone matching or implicit contact creation.
- The CRM worker retrieves the canonical guest through an **existing authenticated PMS reservation API**, using a previously synchronized reservation for that guest/property.
- `sync_mapped_pms_guest_contact()` updates mapped contact name/email/phone and records an event timestamp under a row lock to ignore older guest events. CRM-only tags, consent, notes, conversations and history are untouched.
- A non-E.164 PMS phone is not copied onto an existing CRM phone. Explicit clears are propagated as empty string (phone) or NULL (name/email).

## Prerequisites and rollout (not performed)
1. Deploy the CRM SQL migration `supabase/migrations/89_pms_guest_updated_contact_sync.sql` **before** deploying this application branch. This adds the version-checked RPC and includes `guest.updated` in the webhook worker wakeup trigger.
2. Deploy the CRM application code.
3. On the **PMS** integration subscription (not CRM Supabase), add `guest.updated` to the RZ-CRM webhook subscription for the relevant host/property. This must occur only after the CRM receiver and worker are deployed.
4. Trigger a controlled guest name/email/phone edit and verify: PMS domain_events -> PMS webhook_deliveries -> CRM pms_webhook_events processed -> matching CRM contacts. Monitor both retry queues.

## Current limits
- **Directory-only guests** with no linked synchronized reservation are safely ignored. A future secure PMS `getGuest` endpoint can remove that limitation without redesigning the event queue. Do not advertise directory-only synchronization as working yet.
- This implementation intentionally does not trigger reservation automations.
- The migration and branch have not been applied to DEV or PROD databases or deployed.
- Migration may need reconciliation with other pending migrations before deployment; apply in sequence.

## Pending validation
- Execute TypeScript/Vitest suites in a checked-out branch and run migration in a disposable database.
- Verify webhook ingest validation, retry flow, stale-event rejection, cross-property/account isolation, phone uniqueness conflicts, cleared fields, and no new contact creation.
