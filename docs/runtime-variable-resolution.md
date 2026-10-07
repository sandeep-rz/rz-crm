# Runtime variable resolution (Step 4)

`resolveRuntimeVariables` is a server-only service. Trusted server callers must
supply their already-authorized account ID; the service does not authenticate a
browser session. There is no public endpoint and no connection to message sends,
automations, broadcasts, or semantic compilation.

```ts
import { resolveRuntimeVariables } from '@/lib/message-variables/runtime-resolver';

const result = await resolveRuntimeVariables({
  accountId,
  context: { reservationId },
  variableKeys: [
    'workspace.name',
    'contact.first_name',
    'property.name',
    'listing.check_in_time',
  ],
});
```

## Ownership and context

Active validity comes from `message_variable_catalog`, using the existing catalog
loader. Unknown/inactive keys reject the operation before provider requests.
Repeated keys are deduplicated. Empty key lists perform no I/O.

`workspace.name` is clearly CRM-owned and reads `accounts.name` by account ID.
For reservation operations, the other current v1 keys are PMS-owned, including
contact/property projections and derived reservation values. Their catalog
`resolution_source` is guidance: the presence of synchronized context fields does
not make those fields authoritative at runtime. No calculations based on stale
CRM projections are used. Future clearly CRM-owned variables need explicit local
handlers; adding a catalog entry alone does not introduce a local resolver.

The service loads `pms_reservations` by reservation ID **and account ID**, then
loads its property and integration within that same account. It checks IDs and
relationships and requires an active property and connected integration.
Caller-controlled provider/source fields are rejected.

The external ID is `pms_reservations.external_reservation_id`. Synchronization
persists `metadata.source_type` from the existing RZ reservation contract:

| Synced source  | RZ variable resolver source | Authoritative messaging ID |
| -------------- | --------------------------- | -------------------------- |
| `bookings`     | `rz_booking`                | `bookings.id`              |
| `pms_bookings` | `pms_booking`               | `pms_bookings.booking_id`  |

This translation lives only in the RZ adapter. Unknown sources are configuration
failures; channels are never used to infer a source type.

## Transport and authentication

The existing `PmsHttpClient` uses server environment configuration:
`RZ_PMS_API_BASE_URL`, `RZ_PMS_API_KEY_ID`, and `RZ_PMS_API_SECRET`. Outbound
credentials are not stored as per-integration encrypted database values. The raw
secret is deployment configuration; PMS stores its SHA-256 hash. Incoming CRM
`pms_provider_credentials` are a separate authentication direction and are not
used for outbound resolution.

The adapter reuses the deployment's existing PMS service credential. PMS verifies
that it is valid, active, unrevoked, unexpired, for `service_code=rz_crm`, and has
`reservations:read`. PMS then resolves the booking, derives its authoritative
property, and requires a connected `rz_crm` entry in `property_app_connections`.
CRM sends no connection IDs and neither reads nor mutates credential metadata.
The credential represents the trusted service/environment; property authorization
belongs to PMS. Keep credentials aligned with DEV/production. Rotating the secret
requires updating deployment configuration; adapters are constructed per operation.

One bulk POST, without retries:

```http
POST <RZ_PMS_API_BASE_URL>/v1/integrations/rz-crm/variables/resolve
Authorization: Bearer <server secret>
x-rz-key-id: <existing service key ID>
Content-Type: application/json
```

```json
{
  "contract_version": "v1",
  "context": {
    "source_type": "pms_booking",
    "source_record_id": "<derived external reservation UUID>"
  },
  "variables": ["contact.first_name", "property.name", "listing.check_in_time"]
}
```

The POST deadline is 10 seconds by default, including body parsing. Abort plus a
promise deadline bounds even a transport that ignores abort. Existing GET behavior
is preserved. The POST aborts the underlying request at the deadline and releases
unread response bodies on completion.

## Results and operational failures

A successful provider response preserves `resolved` (string), `missing` (null),
and `unsupported` (null). `success: true` means resolution completed, not that
all requested variables are usable. No preview samples or fallback values are
applied. Extra response keys are ignored. Bad versions, mismatched context,
missing requested entries, invalid statuses, blank resolved values, and wrong
value types fail the provider operation.

Example with illustrative, non-live values:

```json
{
  "success": true,
  "contractVersion": "v1",
  "values": {
    "workspace.name": {
      "status": "resolved",
      "value": "Demo workspace",
      "source": "crm"
    },
    "contact.first_name": {
      "status": "resolved",
      "value": "Demo contact",
      "source": "provider"
    },
    "property.name": {
      "status": "resolved",
      "value": "Demo property",
      "source": "provider"
    },
    "listing.check_in_time": {
      "status": "missing",
      "value": null,
      "source": "provider"
    }
  },
  "invalidKeys": [],
  "failures": []
}
```

Failures are separate from variable results and include the affected canonical
keys, source, code, and retryability. Local results survive provider failures;
failed provider keys have no variable entries. Timeout, rate limit, temporary
network/5xx, invalid response, and database/catalog lookup failures are retryable.
Authentication/access, configuration, missing entities, and invalid input are
not retryable without correction. The service and adapter emit no logs containing
resolved values, booking contexts, raw exceptions, credentials, or provider bodies.

## Unsupported reservation variables

`reservation.channel` and `reservation.currency` remain provider-owned. Current
CRM values are synchronized projections, not authoritative late-bound sources.
RZ PMS v1 returns `unsupported` for these keys. They are not made local merely
because CRM stores a channel/currency column, and reservation currency is never
substituted with `property.currency`. `workspace.name` is resolved locally and
never included in the PMS request.

## PMS error classification

| HTTP status                                           | Runtime failure      | Retryable |
| ----------------------------------------------------- | -------------------- | --------- |
| 400 / 413                                             | `invalid_request`    | No        |
| 401                                                   | `authentication`     | No        |
| 403, including missing scope or disconnected property | `access_denied`      | No        |
| 404, including either booking source not found        | `not_found`          | No        |
| 429                                                   | `rate_limited`       | Yes       |
| 5xx / transport failure                               | `upstream_temporary` | Yes       |
| Deadline exceeded                                     | `timeout`            | Yes       |
| Malformed response                                    | `invalid_response`   | Yes       |

Provider failures can include `httpStatus` and an allowlisted `providerCode`.
Unknown provider codes and upstream messages/bodies are discarded. No HTTP-client
retries are added; later job infrastructure will own retries. These failures never
become variable-level `missing` or `unsupported`.

## Controlled DEV verification — 2026-10-07

The opt-in integration test selects an existing active DEV integration/property
and canonical reservation, and refuses any PMS host except
`dev-api.rukiyezara.com`. It issues no database writes or message sends. Run with:

```sh
RGCRM_RUNTIME_DEV_TEST=1 npm test -- src/lib/message-variables/runtime-resolver.live.test.ts
```

The corrected-contract request derived `pms_bookings` → `pms_booking`, resolved
`workspace.name` locally, and sent the other three keys in one bulk request.
PMS returned HTTP 500 `internal_error`, surfaced as a retryable
`upstream_temporary` provider failure. Provider values were not synthesized.

A read-only query against `rz-pms-dev` confirmed
`public.rz_jsonb_get_text_by_paths(jsonb,text[])` is absent. This matches the known
DEV deployment gap for `20261006165225_rgcrm_variable_path_batch.sql`.
CRM request/auth/routing reached PMS successfully; PMS DEV deployment is missing
the Step 2 batch-helper migration. The HTTP response itself exposes only
`internal_error`; no underlying PostgREST error was captured by CRM.

After the PMS migration/API deployment, rerun the same test and require HTTP 200
before calling end-to-end Step 4 fully verified. The live test continues to fail
until successful resolution; the normal suite skips it. No PMS deployment,
credential permissions, or message-send wiring was changed.

Focused validation passes with 211 tests, including 58 runtime unit tests.
Typecheck and scoped lint are checked separately. Existing locale-parity failures
from earlier template UI changes and the `lucide-react@1.30.0` distribution's
missing `dist/esm/icons/building-complex.mjs` file are unrelated validation blockers.
