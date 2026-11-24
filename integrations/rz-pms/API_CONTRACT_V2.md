# RZ-PMS: capability resolver HTTP endpoint (proposed)

**Location of this spec and SQL:** CRM PR #1 only. The PMS application repository is not attached to this PR, so the HTTP route below is **not yet implemented or deployed in RZ-PMS**. The SQL file under `integrations/rz-pms/supabase/migrations` is a separately reviewed PMS migration: never run it with the CRM Supabase migration set.

## New API for CRM's opt-in v2 adapter

`POST /v1/integrations/rz-crm/capabilities/resolve`

Authenticate using the **existing** PMS service-to-service secret mechanism (`Authorization: Bearer ...` and `x-rz-key-id`). Verify the service credential and dedicated capability-read scope; credentials must be bound to the installed CRM integration. A key/secret by itself must not authorize arbitrary host IDs or access to another installation.

### Request (CRM)

```json
{
  "contract_version": "v2",
  "context": {
    "source_type": "pms_booking",
    "source_record_id": "00000000-0000-4000-8000-000000000003",
    "external_account_id": "provisioned-external-account",
    "external_property_id": "456"
  },
  "capabilities": [
    "reservation.digital_checkin_url",
    "reservation.review_destination_url",
    "reservation.review_url"
  ]
}
```

### Required PMS handler sequence

1. Authenticate service identity, key status, tenant/installation and capability scope, using the existing service auth implementation.
2. Validate a strict request schema and max requested capability count; allowlist known capability identifiers. Disallow caller-supplied `host_id`, `group_id`, `property_id` and raw API URLs.
3. Resolve `external_account_id` to the **provisioned, authorized PMS host/group identity** for that service credential. Resolve `external_property_id` under that host. Do not assume a CRM ID equals a PMS host/group ID.
4. Call `crm_read_reservation_capabilities_v2(source_type,source_record_id,trusted_host_id,trusted_property_id)` as service role. This is read-only and checks reservation-property-host linkage again.
5. Project only requested keys from the RPC's results. Echo the **validated** `external_account_id` and `external_property_id` along with source fields in the response. The CRM rejects context mismatches.
6. Return `resolved | missing | unsupported` and safe, documented reason codes. Do not include entire booking records, access tokens outside requested URLs, debug payloads, upstream errors, or database internals.
7. Cache property capability declarations (not bearer URLs) only when invalidation/freshness is defined. Never generate a check-in link in this endpoint.

### Response example (representative only)

```json
{
  "success": true,
  "contract_version": "v2",
  "context": {
    "source_type": "pms_booking",
    "source_record_id": "00000000-0000-4000-8000-000000000003",
    "external_account_id": "provisioned-external-account",
    "external_property_id": "456"
  },
  "values": {
    "reservation.digital_checkin_url": {
      "status": "missing",
      "value": null,
      "reason": "not_ready"
    },
    "reservation.review_destination_url": {
      "status": "resolved",
      "value": "https://www.airbnb.co.in/trips"
    },
    "reservation.review_url": {
      "status": "unsupported",
      "value": null,
      "reason": "provider_unsupported"
    }
  }
}
```

### Link creation is a different operation

`ensure_guest_checkin_session_for_booking` is a state-changing PMS function: it may issue a token, create a session, and update expiry. It must remain behind an explicit, idempotent reservation lifecycle action. The read-only capability endpoint must **never** call it. Once a session exists, the new RPC can read an eligible existing link without side effects.

### Review reminders and sender ownership

PMS has a `resolve_whatsapp_review_url` that returns general trips/booking pages. It must not be misclassified as a verified direct review-submission URL. CRM can schedule reminders from checkout and stop them when cancellation, review completion, opt-out or duplicate-send evidence exists. If PMS is also configured to send using AiSensy, host must opt into exactly one owner for each message category (CRM or PMS), with a shared deduplication strategy before both are enabled.

### Release gates

- Update/deploy PMS application handler and its separately reviewed PMS migration.
- Validate PMS service-scope mapping and cross-host/property tests.
- Verify PMS expiry/revocation and review-link semantics with fixtures.
- Deploy CRM adapter and CRM migration 94 under separate approval.
- Enable each catalog key (currently `is_active=false`) only after both sides work.
- Add capability condition/fallback templates for CRM WhatsApp automations; never silently substitute missing links.

Existing `/variables/resolve` contract v1 stays unchanged; v2 is opt-in.
