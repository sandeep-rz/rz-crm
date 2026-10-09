# 1. Executive Verdict

**The shared semantic architecture is fundamentally correct, but the migration is incomplete.**

- **PMS and non-PMS sends are supported:** CRM contact/workspace variables resolve without reservation context or a PMS HTTP request.
- **Modern consumers converge:** ID-based automation actions, dashboard manual sends, and configured broadcasts use shared preparation, resolution, and Meta assembly.
- **P1 problems remain:** public single-message/MCP sends and name-based automation actions can send configured templates through positional paths. Automation retries can also resend already-delivered messages.
- **No P0 cross-account or wrong-recipient exploit was established in this audit.**

Audited checkout: `a87704a`. **461 tests passed across 22 files.** Working tree remained clean during the audit. No edits, migrations, deployments, live PMS requests, or real WhatsApp sends were performed during the audit. Findings below distinguish source-verified behavior from paths tested with mocks.

# 2. Consumer Matrix

Classification: **A** shared semantic pipeline; **B** intentional legacy fallback; **C** needs migration; **D** not a template-send consumer. No code was classified **E — dead** without proof.

| Consumer                     | Entry Point                                      | Semantic Pipeline                      | PMS Optional                                          | Legacy Path                                 | Status                         |
| ---------------------------- | ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------- | ------------------------------------------- | ------------------------------ |
| PMS event automation         | PMS webhook → scheduler → worker → engine        | Yes, with `template_id`                | Required by trigger, not intrinsically by send action | Name-based actions remain                   | A / B / C                      |
| PMS scheduled automation     | Reservation schedule → same worker/engine        | Yes, with `template_id`                | Required by schedule                                  | Same legacy actions                         | A / B / C                      |
| CRM/inbound/tag automation   | Trigger dispatch → engine                        | Yes, with `template_id`                | Yes                                                   | Name-based actions remain                   | A / B / C                      |
| Manual automation trigger    | `/api/automations/engine`                        | Depends on action branch               | Yes                                                   | Same engine branches                        | A / B / C                      |
| Automation wait continuation | Pending execution → automation cron/worker       | Depends on action branch               | Yes                                                   | Same engine branches                        | A / B / C                      |
| PMS automatic/manual retry   | Trigger-job worker; execution retry endpoint     | Fresh preparation for semantic actions | Depends on variables/trigger                          | Legacy values re-evaluated by legacy branch | A / B; retry issue             |
| Inbox template send          | Template picker → `/api/whatsapp/send`           | Yes for configured local template      | Yes                                                   | Unmapped/manual templates                   | A / B                          |
| Contact-detail template send | Same picker and send endpoint                    | Yes for configured local template      | Yes                                                   | Unmapped/manual templates                   | A / B                          |
| Public single-message API    | `/api/v1/messages`                               | **No semantic option passed**          | Legacy behavior                                       | Caller positional/structured values         | **C for configured templates** |
| MCP single-message tool      | `send_message` → public message API              | Same bypass as API                     | Same as API                                           | Same caller parameters                      | **C for configured templates** |
| Dashboard broadcast          | Browser hook → `/api/whatsapp/broadcast`         | Yes, independently per recipient       | Yes; reservation variables blocked                    | Frozen positional/custom mappings           | A / B                          |
| Public broadcast API         | `/api/v1/broadcasts` → `after(deliverBroadcast)` | Yes, independently per recipient       | Yes; reservation variables blocked                    | Caller parameters for legacy templates      | A / B                          |
| MCP broadcast tool           | Wrapper around public broadcast API              | Same as public broadcast               | Yes                                                   | Same as public broadcast                    | A / B                          |
| Broadcast resume/retry       | `/api/whatsapp/broadcast/[id]/resume`            | Yes for configured templates           | Yes                                                   | Frozen legacy parameters                    | A / B                          |
| Flows                        | Flow runner                                      | No template-send node                  | Not applicable                                        | Text/media/interactive only                 | D                              |
| Campaigns                    | Broadcast terminology                            | No separate sender discovered          | Same as broadcasts                                    | Same as broadcasts                          | D as independent consumer      |
| Template submit/sync/mapping | Template-management APIs                         | Authoring/management, not delivery     | Yes                                                   | Positional import support                   | D                              |
| AI replies/test              | AI text/interactive paths                        | Not template delivery                  | Not applicable                                        | Not applicable                              | D                              |

# 3. End-to-End Architecture

The actual semantic path is:

```text
Authorized account + template ID + optional context IDs
    → prepareTemplateMessage()
        → owned template and WhatsApp connection
        → APPROVED/configured/mapping validation
        → unique canonical keys
        → resolveRuntimeVariables()
            → CRM reads
            → optional explicit reservation context
            → one bulk provider request when needed
    → buildMetaTemplateMessagePayload()
        → buildMetaTemplateComponents()
        → Meta text-parameter normalization
    → existing sendTemplateMessage()
    → messages OR broadcast_recipients persistence
```

The actual legacy path is:

```text
Template name + positional/structured/action-level values
    → legacy resolution/interpolation where applicable
    → buildSendComponents() OR body-only components
    → sendTemplateMessage()
```

The architectural gap is that **some callers choose the legacy path by caller/action shape instead of the selected template’s configured status**.

Consumer execution profiles:

| Feature                   | Recipient / template source                                                    | Context and preparation                                                         | Worker, persistence, retry                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Automation                | Owned trigger contact; action `template_id` or historical name                 | Contact ID plus explicit trigger reservation ID; shared pipeline for ID actions | PMS worker, immediate engine, or wait continuation; `messages` and execution logs; job retries rerun execution |
| Manual inbox/contact      | Owned conversation/contact; picker-selected template                           | Contact ID plus selected reservation ID; shared preparation for configured rows | Immediate endpoint; `messages`; immediate error and phone-variant retry                                        |
| Public/MCP single message | Requested phone resolved to owned contact/conversation; template name/language | Caller values; semantic preparation omitted                                     | Immediate endpoint; same message persistence core; phone-variant retry                                         |
| Dashboard broadcast       | Browser-resolved contact audience; selected template                           | Per-recipient contact ID for configured templates; legacy values frozen         | Browser batch loop; recipient records updated client-side; HTTP 429 replay and server resume                   |
| Public/MCP broadcast      | Requested phones resolved to contacts; name/language resolves template         | Per-recipient shared preparation for configured templates                       | `after()` delivery; recipient records updated server-side; explicit resume/retry                               |
| Broadcast resume          | Stored broadcast/template identity and recipient contacts                      | Fresh semantic values; frozen legacy values                                     | Claimed server resume pass; same delivery core                                                                 |

All discovered template deliveries ultimately call [sendTemplateMessage()](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/meta-api.ts:542). No separate direct Graph template-message sender was discovered.

# 4. Shared Pipeline Review

| Component                   | Result                                                | Evidence                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepareTemplateMessage()`  | **PASS**                                              | Strict input shape; account-scoped template lookup; owned connection; configured and APPROVED requirement; Meta identity/language validation; mapping validation; one runtime call |
| `resolveRuntimeVariables()` | **PASS, within implemented catalog/provider support** | Active catalog validation, deduplicated keys, account-scoped CRM/context reads, explicit reservation requirement, optional bulk provider call                                      |
| Meta payload assembly       | **PASS**                                              | Shared component assembly; required values checked; normalization occurs in provider payload construction                                                                          |
| Low-level Meta sender       | **ISSUE at caller boundary**                          | Accepts both assembled semantic payloads and legacy values; does not itself enforce that configured templates use semantic preparation                                             |

Important ownership distinction: `prepareTemplateMessage()` expects a **trusted, already-authorized account ID**. It validates template/connection ownership; it is not an authentication or membership service.

Contact/reservation ownership is checked when runtime resolution needs those entities. Empty mappings return without runtime entity reads. Send consumers therefore remain responsible for validating the transport recipient independently.

Preparation rejects missing, unsupported, inactive, invalid, or failed variable resolution. Approval samples and default fallbacks do not enter the modern send pipeline.

Sources: [preparation](/Users/mac/Downloads/rz-crm/src/lib/message-preparation/prepare-template-message.ts:18), [mapping validator](/Users/mac/Downloads/rz-crm/src/lib/message-preparation/mapping.ts), [runtime resolver](/Users/mac/Downloads/rz-crm/src/lib/message-variables/runtime-resolver.ts:124), [Meta assembly](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/meta-template-payload.ts).

**Component coverage:** BODY and text HEADER positions are sorted independently; repeated canonical variables populate every mapped occurrence; URL buttons retain their button indices. Media headers use stored runtime media URLs. COPY_CODE is unsupported in the modern preparation path.

**Normalization:** CR/LF/TAB runs become spaces; runs of five or more spaces become four spaces. BODY/text HEADER values are normalized; URL suffixes deliberately remain verbatim. The resolved canonical-value object is not mutated. [Normalization implementation](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/meta-parameter-utils.ts)

# 5. PMS vs Non-PMS Review

| Variables                                                      | Actual resolution                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `workspace.*` with workspace/CRM metadata                      | Owned account data; currently `workspace.name` is implemented                     |
| `contact.*` with contact/CRM metadata                          | Owned CRM contact                                                                 |
| `contact.*` with contact/context metadata, without reservation | Owned CRM contact                                                                 |
| `contact.*` with contact/context metadata, with reservation    | Provider booking guest context takes precedence                                   |
| Reservation/property/listing/host/provider scopes              | Explicit CRM reservation → owned property/integration mappings → provider adapter |

CRM contact resolution supports first name, remaining name, full name, phone, and email through the catalog’s `resolver_key`.

When both IDs are present:

- `contact.*` marked **`context`** uses booking/provider context.
- `contact.*` marked **`crm`** continues using the CRM contact.
- Transport destination continues coming from the intended recipient.

The shared runtime resolver does **not** select the latest, first, newest, or upcoming reservation. Provider variables without explicit reservation context fail.

The manual picker can auto-select one appropriate contact reservation. When multiple relevant reservations exist, it requires a choice; this UI behavior does not introduce a hidden resolver fallback.

**Catalog ownership:** `variable_key` is durable identity; `source_scope` and `resolution_source` drive routing; `resolver_key` selects implemented extraction; category/order drive presentation. Labels and preview values drive editor presentation/approval examples.

No duplicate frontend canonical-key-to-label catalog was found. The runtime CRM extraction map is an implementation adapter, not a second authoring catalog. The older context-based resolver remains a **second live resolution implementation for legacy mappings**, including fallback behavior.

The RZ adapter forwards requested canonical keys in one bulk request; provider schema extraction is external to this repository. Only the Rukiye Zara provider is registered here. [Provider adapter](/Users/mac/Downloads/rz-crm/src/lib/integrations/pms/providers/rukiye-zara-variables.ts), [registry](/Users/mac/Downloads/rz-crm/src/lib/integrations/pms/variable-registry.ts)

# 6. Automation Review

Modern `send_template` actions use:

```text
cfg.template_id
    → owned contact + optional context.reservation.reservation_id
    → preparation
    → Meta assembly
    → template connection-specific conversation
    → engineSendTemplate()
    → messages
```

PMS events map into the existing scheduler/trigger-job worker. The worker reloads reservation context and supplies its contact and reservation identity. Non-PMS triggers supply contact context and can send contact/workspace templates without PMS.

**The semantic send action itself does not require a reservation ID.**

The builder disables reservation-dependent templates for non-PMS triggers using catalog metadata and `variableRequiresReservation()`. However, server action validation primarily validates the template UUID’s shape; it does not enforce this trigger/template capability relationship at save time. Such actions can be saved through the API and then fail safely during preparation.

Two name-based legacy branches remain:

1. `variable_mappings` → `buildAndResolveMessageVariables()` → grouped parameters.
2. Historical `variables` → numeric ordering/interpolation → parameters.

Neither branch checks whether its named template is now configured. This permits a configured semantic template to be sent using legacy action-level values.

Sources: [engine branches](/Users/mac/Downloads/rz-crm/src/lib/automations/engine.ts:695), [automation sender](/Users/mac/Downloads/rz-crm/src/lib/automations/meta-send.ts), [server validation](/Users/mac/Downloads/rz-crm/src/lib/automations/validate.ts:130), [builder controls](/Users/mac/Downloads/rz-crm/src/components/automations/send-template-fields.tsx).

# 7. Manual Send Review

**PASS for configured templates resolved by the dashboard send path.**

Inbox and contact detail reuse the same picker and endpoint:

- Configured templates have no positional input controls.
- Valid mappings are checked with the shared validator.
- Catalog labels appear in previews.
- CRM-only templates have no reservation selector.
- Reservation-dependent templates load workspace/contact-scoped stays.
- Selected IDs reach the existing semantic preparation path.
- Caller body/header/button values are ignored after semantic preparation activates.

The inbox contact derives from the owned conversation; contact-detail sends provide the contact explicitly. The selected reservation supplies booking values and does not change the recipient.

Backend manual sends also support configured template lookup by name because the dashboard route passes the semantic option even when `template_id` is omitted.

Legacy/unmapped templates retain manual positional fields.

Sources: [picker](/Users/mac/Downloads/rz-crm/src/components/inbox/template-picker.tsx), [inbox caller](/Users/mac/Downloads/rz-crm/src/components/inbox/message-thread.tsx:704), [contact caller](/Users/mac/Downloads/rz-crm/src/components/contacts/contact-detail-view.tsx:453), [send route](/Users/mac/Downloads/rz-crm/src/app/api/whatsapp/send/route.ts:180), [semantic send branch](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/send-message.ts:373).

# 8. Broadcast Review

**Configured broadcasts use shared preparation independently per recipient.**

Three execution implementations remain:

1. Dashboard browser loop calling the dashboard batch endpoint.
2. Public API planning plus server `deliverBroadcast()`.
3. Resume planning followed by that same server delivery core.

The dashboard batch endpoint and server delivery core each create a new prepared payload inside the recipient loop. Contact A’s resolved payload is not reused for Contact B.

Semantic broadcast validation rejects reservation-dependent templates for ordinary contact audiences. No per-recipient reservation contract is currently implemented; the code does not guess one.

Configured semantic recipients store identity rather than frozen runtime values. Resume resolves fresh values. Legacy recipients replay frozen parameters.

Two differences matter:

- The dashboard batch endpoint accepts `phone` and `contact_id` independently. It does not verify that the phone corresponds to that contact.
- Broadcast sends persist broadcast-recipient status/Meta IDs, but do not insert outgoing inbox `messages` rows in these delivery implementations.

The public planner resolves each phone to a contact, avoiding the independent-ID pairing used by the dashboard batch contract.

Sources: [dashboard hook](/Users/mac/Downloads/rz-crm/src/hooks/use-broadcast-sending.ts), [batch endpoint](/Users/mac/Downloads/rz-crm/src/app/api/whatsapp/broadcast/route.ts:215), [public delivery](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/broadcast-core.ts:302), [resume](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/broadcast-resume.ts:148).

# 9. Flows / Campaigns / Other Consumers

**Flows:** repository-defined interactive conversation graphs. Supported delivery nodes send text, media, buttons, lists, and input prompts. There is no `send_template` node. Flow `{{vars.foo}}` interpolation is unrelated to semantic WhatsApp template compilation. No flow template migration is currently needed. [Flow node types](/Users/mac/Downloads/rz-crm/src/lib/flows/types.ts)

**Campaigns:** used as terminology for broadcasts; no independent campaign template sender was discovered.

**MCP:** single-message and broadcast tools wrap public APIs. The single-message tool inherits the public API semantic bypass; the broadcast tool inherits semantic broadcast behavior. [MCP message tool](/Users/mac/Downloads/rz-crm/mcp-server/src/tools/write.ts), [broadcast tool](/Users/mac/Downloads/rz-crm/mcp-server/src/tools/broadcast.ts)

**Webhooks/system triggers:** dispatch existing automation execution and process delivery/template status updates; they do not introduce another template sender.

**Authoring/import management:** compiler/parser correctly separates catalog labels, canonical identities, and Meta positions:

- Editor chips persist canonical keys, never labels.
- Compiler assigns positions per component and per occurrence.
- Approval samples are authoring data.
- Imported positional templates become `needs_mapping`; manual mappings supply meaning.
- RGCRM-authored mappings derive from semantic content.
- Creation components and send components serve different APIs and are not duplicate send builders.

Sources: [editor](/Users/mac/Downloads/rz-crm/src/components/settings/semantic-template-editor.tsx), [compiler/import reconciliation](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/semantic-template.ts).

No separate template test/debug sender was discovered. The authenticated automation trigger endpoint can indirectly send templates through the engine.

# 10. Legacy Positional Code

| Live code                                       | Why it remains                                         | Classification                                     |
| ----------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| Picker BODY/HEADER/URL inputs                   | Imported/unmapped manual sends                         | B                                                  |
| `buildSendComponents()`                         | Legacy structured send components, media/buttons       | B                                                  |
| Low-level body-only component assembly          | Legacy sends without a local template row              | B                                                  |
| `templateBodyParams()` / `renderTemplateBody()` | Parameter handling and rendering persisted body text   | B; also used legitimately after semantic assembly  |
| Automation `variable_mappings`                  | Historical action-level catalog/custom/static mappings | B for legacy templates; C for configured templates |
| Automation `variables` interpolation            | Historical positional action records                   | B / C                                              |
| Broadcast personalization mappings              | Legacy audience fields/custom/static values            | B                                                  |
| Stored recipient `template_params`              | Frozen legacy resume values                            | B                                                  |
| Public/MCP message parameters                   | Existing public contract                               | B for legacy templates; C for configured templates |
| Older message-variable resolver                 | Snapshot context extraction and fallback handling      | B                                                  |

The presence of `{{1}}` in approved transport content or persistence rendering is not itself a migration defect. The defect is allowing caller/action values to supply those slots for a configured semantic template.

# 11. Recipient Safety

**Verified separation:**

- Manual: owned conversation/contact determines destination.
- Automation: owned trigger contact determines destination.
- Public messages: requested phone resolves the recipient contact/conversation.
- Public broadcasts: requested phones resolve recipient contacts.
- Resume: recipient contact phone determines destination.

No modern sender was found using resolved `contact.phone` as its transport target. Booking guest values can differ from the CRM recipient without redirecting delivery.

**Dashboard broadcast contract gap:** independently supplied contact ID and phone can produce Contact A’s template values sent to phone B. The normal browser hook supplies matching pairs, but the endpoint does not enforce that relationship.

This is a **P2 recipient/context consistency issue**. No cross-account data retrieval was demonstrated.

# 12. Retry / Resume / Persistence

| Consumer                 | Persistence                                                                              | Retry/resume values                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Automation               | Conversation `messages`, bot sender, template name, Meta ID, sent status; execution logs | Semantic values freshly prepared when action runs again                    |
| Manual                   | Conversation `messages`, agent sender, template name, Meta ID, sent status               | Fresh preparation on a new send; phone variants reuse the prepared payload |
| Public message API       | Same manual send-core persistence                                                        | Caller values through current legacy path                                  |
| Dashboard broadcast      | Broadcast and recipient records; browser updates result status/Meta ID                   | Semantic values fresh; legacy values frozen                                |
| Public/resumed broadcast | Recipient records updated server-side                                                    | Semantic values fresh; legacy values frozen                                |
| Flows                    | Text/media/interactive messages                                                          | Not template delivery                                                      |

Connection association for inbox messages is carried through the conversation; broadcasts store their WhatsApp connection.

**Persistence inconsistency:** automation semantic body text uses raw resolved values, while manual semantic persistence reconstructs body text from normalized Meta parameters. Newlines/tabs therefore can appear differently in stored previews for otherwise equivalent sends.

**Automation retry risk:** attempts remain visible, and completed-job gates/locking prevent retries of completed occurrences. However, failed occurrences restart at step position zero. Earlier successful sends are not skipped. Manual eligibility also does not exclude a failure after Meta accepted the message but local persistence failed.

**Broadcast durability:** dashboard execution depends on the browser; public `after()` execution is bounded by route duration. Resume exists, but there is no durable automatic broadcast drain demonstrated here. A successful Meta send followed by an unrecorded recipient update can remain eligible for another send.

The “schedule/send” broadcast component currently offers send-now/save-draft; it is not evidence of an independent scheduled broadcast worker.

# 13. Security Findings

**Verified defenses:**

- Authenticated account/role or scoped API key supplies tenancy.
- Modern preparation validates template and connection ownership.
- CRM contact/reservation/property/integration reads are account-scoped.
- Automation dispatch validates contact/conversation ownership.
- Modern semantic callers do not accept arbitrary prepared Meta components.
- Semantic manual/broadcast branches discard caller positional values.

**Gaps:**

1. Public single-message API/MCP can bypass semantic preparation.
2. Name-based automation actions can bypass template-owned semantic mapping.
3. Dashboard broadcast contact/phone pairing is not enforced.
4. Legacy template lookup does not enforce local APPROVED/configured status; Meta remains the final authority there.

No access-token or full resolved-payload logging was found in shared preparation/resolution. Existing wrappers do log phone numbers and unfiltered Meta error strings/details. Those error fields may contain contextual information; they are not equivalent to a sanitized diagnostic contract.

# 14. Performance Findings

- Modern PMS resolution makes **one bulk provider call per preparation**, not one call per variable.
- CRM-only preparation avoids PMS reads/HTTP calls.
- Canonical keys are deduplicated before resolution.
- Broadcast per-recipient payload state is isolated.
- Broadcast preparation repeats template/connection/catalog lookups per recipient, even after batch-level validation. This is an optimization opportunity, not evidence of incorrect resolution.
- Public broadcast planning resolves contacts sequentially; delivery is also sequential.
- Dashboard and server broadcast execution duplicate orchestration, retry, and result handling.
- Template/catalog UI reads wait on asynchronous connection selection; the current loader avoids presenting an empty result during that wait.

No optimization or refactoring was performed.

# 15. Findings by Priority

## P0

**None established.** This is a repository audit, not proof of production end-to-end security.

## P1

**F1 — Public single-message/MCP semantic bypass**

- **Files/functions:** [public POST](/Users/mac/Downloads/rz-crm/src/app/api/v1/messages/route.ts:111), [send-core branch](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/send-message.ts:373), MCP `send_message`.
- **Current:** public POST omits the fourth semantic/manual option. A configured local row still receives caller parameters.
- **Expected:** configured status activates shared preparation regardless of originating consumer.
- **Why it matters:** caller values replace canonical resolution and bypass its mapping/context/status safeguards.

**F2 — Name-based automation semantic bypass**

- **Files/functions:** [executeAutomationStep()](/Users/mac/Downloads/rz-crm/src/lib/automations/engine.ts:695), [engineSendTemplate()](/Users/mac/Downloads/rz-crm/src/lib/automations/meta-send.ts:70).
- **Current:** only presence of `template_id` selects semantic execution. Name-based actions can target configured templates with legacy values.
- **Expected:** a resolved configured template must use template-owned semantic preparation.
- **Why it matters:** duplicate action mappings/interpolation can override semantic identity and provider resolution.

**F3 — Failed automation retry can duplicate delivered templates**

- **Files/functions:** [execution restart](/Users/mac/Downloads/rz-crm/src/lib/automations/engine.ts:420), automation sender persistence handling, [retry RPC](/Users/mac/Downloads/rz-crm/supabase/migrations/71_manual_pms_automation_retry.sql:203).
- **Current:** failed execution restarts at zero. A successful earlier send, or Meta-accepted send followed by DB failure, can be sent again. Manual eligibility does not exclude the latter.
- **Expected:** retry eligibility/execution must distinguish safe failures from already-performed outbound effects.
- **Why it matters:** hosts can unintentionally send duplicate customer messages. Fresh semantic resolution does not provide idempotency.

## P2

**F4 — Trigger/template compatibility is enforced in UI, not save API**

- **Files/functions:** [send-template builder fields](/Users/mac/Downloads/rz-crm/src/components/automations/send-template-fields.tsx), [validateStepConfig()](/Users/mac/Downloads/rz-crm/src/lib/automations/validate.ts:130), automation create/update routes.
- **Current:** UUID-valid reservation-dependent actions can be saved against non-PMS triggers through the API.
- **Expected:** reject incompatible configuration before activation.
- **Why it matters:** automation saves successfully but fails at send time. Runtime fails closed.

**F5 — Dashboard broadcast recipient/context IDs are independent**

- **File/function:** [broadcast POST recipient loop](/Users/mac/Downloads/rz-crm/src/app/api/whatsapp/broadcast/route.ts:215).
- **Current:** `contact_id` supplies semantic values; `phone` independently supplies destination.
- **Expected:** enforce the intended contact/destination association.
- **Why it matters:** mismatched pairs send one contact’s personalization to another destination.

**F6 — Broadcast deliveries lack outgoing inbox message persistence**

- **Files/functions:** dashboard broadcast POST/hook and [deliverBroadcast()](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/broadcast-core.ts:302).
- **Current:** record recipient status/Meta ID without corresponding conversation `messages`.
- **Expected:** explicitly decide and consistently implement whether template broadcasts appear in conversation history.
- **Why it matters:** host-visible message history differs across consumers; successful broadcast sends are not persisted like manual/automation sends.

**F7 — Static imported configured templates are inconsistently rejected**

- **Files/functions:** [importedMetadata()](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/semantic-template.ts:304), [semanticBroadcastTemplateIssue()](/Users/mac/Downloads/rz-crm/src/lib/broadcast-message-variables.ts:207), [semanticTemplateIsUsable()](/Users/mac/Downloads/rz-crm/src/lib/automations/semantic-template-action.ts).
- **Current:** static Meta imports become configured with empty mapping and null semantic content. Shared preparation can accept that shape, but broadcast/automation selection guards require semantic content.
- **Expected:** consistently recognize valid zero-variable imports or consistently assign a different readiness contract.
- **Why it matters:** an approved template usable in manual sending can be unavailable in automation/broadcast.

## P3

- Automation/manual persistence differs on normalized versus raw body values.
- Legacy lookups permit unknown/local-nonapproved templates and defer rejection to Meta.
- Duplicate broadcast orchestration and separate legacy resolution remain maintainability costs.
- Phone/error logging lacks consistent sanitization.
- Some wrapper comments describe older behavior and should not be treated as architecture evidence.

## P4

- Reduce repeated template/catalog reads without freezing runtime values.
- Improve broadcast delivery durability beyond browser execution and bounded `after()`.
- Add explicit future reservation-based broadcast audiences if needed.

# 16. Remaining Migration Work

The minimum work required to claim **“Every configured semantic template send uses the shared pipeline”** is:

1. Make configured template status activate semantic preparation in the shared single-message send core, including public API/MCP callers.
2. Resolve name-based automation actions before choosing execution mode; configured templates must use shared preparation, while genuinely legacy/unmapped templates retain their current path.
3. Add regression coverage proving caller/action values cannot override configured mappings across these entry points.

Broadcast persistence, retry safety, configuration validation, and static-import consistency require separate decisions. They should not be disguised as prerequisites for replacing the resolver/compiler.

# 17. Code That Can Eventually Be Removed

**No current helper was proven universally dead or safe to delete.**

After the two bypasses migrate:

- Legacy positional branches should become unreachable **for configured templates**.
- Action-level mappings/variables should cease controlling configured automation sends.
- Public positional values should cease controlling configured single-message sends.

Those implementations still have legitimate unmapped/legacy consumers. Keep them until those consumers are explicitly retired.

Creation component builders, positional transport rendering, and semantic compiler numbering should remain.

# 18. Recommended Next Step

**Close the public single-message/MCP bypass in the shared send core.**

Make the resolved template’s configured status—not a dashboard-only option—activate `prepareTemplateMessage()` and Meta assembly. Derive the contact from the owned conversation, allow explicit reservation context where needed, discard caller variable overrides, and preserve positional sending for genuine legacy/unmapped templates.

This is the smallest high-impact task because it secures both the public API and MCP consumer through one existing send boundary.
