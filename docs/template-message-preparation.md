# Template message preparation (Step 5A)

This is a server-only, read-only preparation pipeline. It has no public route,
provider message request, template submission, automation/broadcast execution, or
manual-send integration. Trusted server callers supply an already-authorized
workspace ID. Step 5B will own delivery orchestration.

## Repository architecture reviewed

- `message_templates` already stores `account_id`, `whatsapp_config_id`, Meta
  identity/status, semantic content, occurrence mapping, and configuration status.
  Migration 70 defines RGCRM semantic authoring versus explicitly mapped Meta imports.
- `semantic-template.ts` is the existing Step 3 compiler. It assigns positions per
  component, including one URL suffix slot per zero-based button index. The same
  canonical key may appear at several positions. Its `positionalSlots` and
  `slotIdentity` helpers are reused for validation; there is no new compiler/catalog.
- Step 4's `resolveRuntimeVariables` owns active-catalog checks, workspace-local
  resolution, account-scoped PMS context, provider selection and bulk resolution.
- Existing Meta sends use `meta-api.ts` and `template-send-builder.ts`. The latter
  can use COPY_CODE approval examples, so it is not reused as a strict runtime assembler.
- Conversation/manual and v1 API sends use `send-message.ts`. Automation sends
  use `automations/meta-send.ts`; flow sends use `flows/meta-send.ts`; broadcast
  delivery uses `broadcast-core.ts` and the broadcast route. All remain unchanged.
- No AiSensy or MSG91 integration was found in this repository. No new provider
  integrations are introduced. WhatsApp connections are represented by
  `whatsapp_config`, with template ownership through `whatsapp_config_id`.

## API and result

```ts
import { prepareTemplateMessage } from '@/lib/message-preparation/prepare-template-message';
import { buildMetaTemplateMessagePayload } from '@/lib/whatsapp/meta-template-payload';

const prepared = await prepareTemplateMessage({
  accountId,
  templateId,
  context: { reservationId },
});
const metaTemplate = buildMetaTemplateMessagePayload(prepared);
// Consume in trusted server code. Never log prepared or metaTemplate.
// Nothing is sent.
```

The provider-neutral result contains:

```ts
{
  template: {
    id, name, language, connectionId,
    body_text, header_type, header_content, header_media_url, footer_text, buttons
  },
  context: { reservationId },
  resolvedVariables: { /* canonical key -> runtime string */ },
  mapping: [ /* component, position, variable_key, optional button_index */ ]
}
```

No approval samples, preview values, fallback values, upload handles, tokens or
service credentials are included. Resolved values themselves are sensitive.
Do not log, cache, persist snapshots of, or send this result to generic telemetry.
Preparation is late-bound; a future delivery attempt should prepare afresh.

## Validation and resolution

The input accepts only account/template IDs and reservation context. Caller-owned
values and provider/source/property IDs are rejected. The template is loaded by
ID and account; a minimal ID/account lookup distinguishes absent from foreign
records for trusted server callers. Both template and WhatsApp connection
ownership are verified even if a query ignores its filters. Credentials are not
loaded or decrypted. Templates require `configured`, `APPROVED`, a synchronized
Meta ID, valid persisted name, and explicit language. No primary-connection or
language fallback is used.

Persisted mappings require an array, canonical keys, positive safe-integer
positions, supported HEADER/BODY/BUTTON components, valid zero-based URL button
indexes, and one entry per transport slot. Body/header transport variables must
be contiguous; URL variables must be a single `{{1}}` suffix. Duplicate slots,
missing/extra slots, malformed tokens and semantic/transport drift fail before
runtime resolution. Restoring semantic keys through the mapping must match the
stored semantic content exactly. RGCRM occurrence numbering must also match
compiler encounter order. Configured Meta imports may reuse one positional slot
several times in their transport text; their explicitly mapped semantic content
must still match. No positional meaning is inferred.

Exactly one Step 4 call receives unique mapped keys. For empty mappings, that
call returns without I/O. Preparation never reads cached PMS/contact values or
calls PMS directly. `resolved` strings are retained unchanged, including `"0"`.
`missing` and `unsupported` block preparation with the canonical key. Operational
failures remain separate, retaining safe Step 4 classifications/retryability.
There are no retries or runtime fallbacks.

## Meta assembly

The deterministic assembler revalidates transport slots and requires every
mapped runtime value. BODY and text HEADER parameters sort numerically by
position, independently of response/catalog/object order. URL buttons sort by
zero-based index and use `{type:'button', sub_type:'url', index:String(index)}`.
Repeated semantic keys resolve once but fill every occurrence slot.

Static text headers, URL buttons, QUICK_REPLY and PHONE_NUMBER buttons need no
send-time parameters. Existing image/video/document headers can use a stored
HTTP(S) runtime media link; media variables and approval upload handles are not
supported. COPY_CODE fails explicitly because no runtime code source exists in
this semantic contract; approval examples cannot become real message values.

`buildMetaTemplateMessagePayload` returns `{name, language:{code}, components?}`: the
exact template portion of a future Meta message request. Recipient and phone
number credentials are deliberately outside Step 5A. No Graph request is made.

## Errors

`TemplatePreparationError.code` distinguishes invalid input, absent/foreign
records, lookup/connection failures, unconfigured/unapproved templates, invalid
mapping, missing/unsupported variables, provider versus other runtime failures,
unsupported components and invalid payloads. Error messages are classifications;
diagnostics contain only canonical keys and safe runtime failure metadata. Raw
exceptions, resolved values and upstream bodies are never attached.

## Verification

Focused tests cover preparation, strict mapping/ownership/input checks, repeated
variables, local/provider merging, failure policy, numerical assembly order,
headers, URL indexes, strings, sensitive logging and sample exclusion. A realistic
compiler-generated template produces exactly four ordered text parameters:
`Sandeep`, `Lombara Homestay`, `15 Oct 2026`, `2:00 PM`. These are unit-test data.

The opt-in real DEV test can be run with:

```sh
RGCRM_TEMPLATE_PREPARATION_DEV_TEST=1 npm test -- src/lib/message-preparation/prepare-template-message.live.test.ts
```

It selects an existing connected DEV integration, approved configured RGCRM
semantic template, and canonical reservation. A transport guard permits only CRM
GETs and the DEV PMS bulk resolver POST, rejecting all other HTTP requests.
Only canonical keys, component/index/count/type information is printed.

On 2026-10-07 the live attempt stopped because the selected workspace had no
approved configured RGCRM semantic template with variables. No fixture was
created, approval status changed, PMS resolver called, or message sent. This is a
missing test prerequisite, not the old batch-helper deployment gap: the Step 4
live resolver passed after that helper was applied. Real template preparation
still needs a successful rerun with an eligible template.

Validation on 2026-10-07: 57 new unit tests; 726 relevant regression tests
passed with two opt-in live tests skipped. The full suite had 1,654 passing tests,
six existing translation-parity/ICU failures, and two skipped live tests.
Typecheck and scoped lint passed. Webpack build remains blocked by the existing
Lucide distribution's missing `icons/building-complex.mjs`. No send paths or
database schema were changed. The code is ready for review; live Step 5A
verification requires an eligible existing template and a successful rerun.

## Final corrections and automation authoring

Step 5A trusts Step 4's status classification. A `resolved` entry must contain a
string, and that exact string is preserved, including `"0"`, empty strings,
whitespace and surrounding spaces. Step 5A and Meta assembly do not trim or
reclassify its content. Missing and unsupported statuses still block preparation;
string-type validation is separate from semantic status.

Automation Send Template authoring now selects `template_id`, retaining
`template_name`/`language` because the current API/legacy executor still require
those identity fields. Selection preserves unrelated action configuration and
removes `variable_mappings` and legacy `variables`. Serialization strips these
fields for actions carrying `template_id`. Untouched older records still reload
and serialize compatibly. No persisted records were rewritten.

The read-only preview uses `semantic_content` and the existing
`renderSemanticText(..., catalog, 'label')` renderer. Labels come dynamically from
`message_variable_catalog.label`; no frontend variable-label dictionary exists.
Automation mappings never influence this preview or the Step 5A preparation
pipeline. Unconfigured templates have disabled selection and a link to template
settings; there is no mapping repair UI in the builder. Approved status,
configured semantics, provider identity, explicit language and the selected
WhatsApp connection gate new selection.

A read-only audit of the configured CRM database on 2026-10-07 found zero
saved automations and zero Send Template steps. This does not establish the state
of other deployments, so legacy execution compatibility is retained.

The old execution path remains explicitly isolated for Step 5B migration:

- `automations/template-variable-mapping.ts` inspects positional header/body
  slots, validates legacy automation mappings and groups resolved values.
- `automations/validate.ts` accepts structurally valid old mapping records.
- `automations/engine.ts` invokes the older `buildAndResolveMessageVariables`
  for `variable_mappings`, or interpolates positional `variables`.
- The old message-variable context/resolver reads synchronized CRM projections
  and supports mapping/catalog fallback values. It is not Step 4 and is not used
  by Step 5A or the new builder preview.

These execution functions were not changed or wired to Step 5A. New semantic
actions require the upcoming Step 5B executor integration before live delivery;
removing UI mapping does not itself enable runtime sends. Step 5B must always use
template-level semantic mapping, never resurrect action-level overrides.

### Reservation Confirmed context for Step 5B

The PMS scheduler stores canonical `pms_reservations.id` in
`automation_trigger_jobs.pms_reservation_id` after property-filter matching.
The worker maps it to `job.reservationId`, loads account-scoped reservation
context, and dispatches `context.reservation.reservation_id`. Step 5B can pass
that exact RGCRM ID, the automation's account ID, and the action's `template_id`
to preparation. It must not use `external_reservation_id`, trigger property IDs,
or caller-supplied PMS source identifiers. Property filters remain independent.

### Manual UI check

Verified in the existing localhost builder: Reservation Confirmed → lakeside
meadows → Send Template → booking_confirmat (en_US). The preview displays current
catalog labels, including contact/listing/check-in/check-out/staff tokens, with
zero positional mapping dropdowns. The automation was not saved or activated;
no runtime resolution or message request was triggered by this check.

Final-fix validation: 75 focused tests and 358 relevant regression tests passed.
Typecheck and scoped lint passed. Full suite: 1,669 passed, six existing
translation/ICU failures, two opt-in live tests skipped. Webpack build was run
and remains blocked by the same missing Lucide module. No migration or send
orchestration was changed.
