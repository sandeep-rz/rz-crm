# PMS automation contact recovery (rebased on main)

Booking-triggered automations that reach a contact-dependent step without a mapped contact, or a WhatsApp step without a valid international recipient, park in `automation_pending_executions` as `blocked_contact`. Prior successful steps are recorded in the existing automation log, while the original PMS job completes. The pending worker checks these rows on each cron tick (recommended once per minute). A host's later phone edit in CRM, or a PMS `guest.updated` sync, allows recovery without replaying earlier sends. The saved cursor resumes the same step and then traverses enclosing condition scopes. The default expiration is 24 hours after the original due time; configurable for newly blocked jobs with `PMS_CONTACT_RECOVERY_EXPIRY_HOURS` (1–720).

## Deployment (not applied)

1. Review code and migration 92, run automation tests and SQL assertions in DEV.
2. Apply migration 92 to DEV first, then deploy the matching CRM code. The new pending worker depends on its RPC.
3. Verify an incoming confirmed reservation with no guest phone parks its template step. Update phone in CRM (or via PMS guest.updated), then invoke the existing authenticated automation cron. Verify one WhatsApp send and no repeated prior steps.
4. Verify cancellation, expiration, deactivation, and no duplicate send after ambiguous Meta acceptance before considering PROD.

## Scope

This is the contact-recovery portion of the former `autostart-automation` snapshot, not its unrelated UI, contact-matching, PMS API or schema rewrites. It does not change existing PMS contact creation or guest synchronization. `main` and the preservation branch are unchanged.
