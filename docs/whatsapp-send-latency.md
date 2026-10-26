# WhatsApp Inbox send latency

26 October 2026. Scope: ordinary Inbox sends and their existing shared send core. No customer messages were sent during this investigation.

## Evidence and limits

The owner reports 8–10 seconds. Source tracing found repeated authentication, repeated conversation reads, and serial post-acceptance writes. The current Supabase project is `ideibnrtszjdrxsusnwc`, PostgreSQL 17, in `ap-northeast-1` (Tokyo); live migration history ends at 84.

Read-only REST probes **from this Mac**, not from the deployed function, measured 994 ms for the first database request and 393/326/256 ms for subsequent requests. These probes fetched no customer content. Live database statistics for sampled message reads/writes were generally a few milliseconds of SQL execution. These facts support network-round-trip overhead as a contributor; they do not isolate the full reported production delay or measure real Meta acceptance/customer delivery.

The Vercel CLI token is invalid, so the actual function region could not be inspected. The site's CDN request location does not prove where its send function runs.

## Changes

The normal authenticated existing-conversation text path, without reply lookup/phone correction/legacy encryption upgrade, now uses roughly **7 instead of 12 Supabase/Auth HTTP round trips**:

| Work                                    | Before | After |
| --------------------------------------- | -----: | ----: |
| Middleware Auth validation              |      1 |     0 |
| Route Auth, profile and active account  |      3 |     3 |
| Account-scoped conversation reads       |      3 |     1 |
| Connection credentials                  |      1 |     1 |
| Shared send allowance                   |      1 |     1 |
| Message, preview and agent flow handoff |      3 |     1 |

The exact POST `/api/whatsapp/send` delegates session validation and refreshed-cookie handling to its existing `requireRole('agent')` route. All other middleware paths keep their current checks. No authorization claims are trusted from the request body.

The shared sender uses its already-authorized conversation's connection ID rather than loading that conversation again. The route also omits the existence query already performed by the sender.

Migration 85 adds one authorized `record_whatsapp_outbound` function over the existing tables. It commits the accepted message and conversation preview in one transaction and performs the existing best-effort agent handoff in that same database round trip. No external API calls run inside the transaction. Duplicate `(conversation_id,message_id)` persistence returns the existing ID without regressing status or pausing a newly started flow. Authenticated users need active-workspace agent membership; service-role public API sends must still target a conversation belonging to the supplied trusted account. Anonymous execution is revoked.

The response still waits for Meta acceptance and persistence. Existing shared quota/offboarding checks and accepted/uncertain-send protections remain. No async acknowledgment, blind resend, worker, queue, cache service or table was added.

### Inbox confirmation follow-up — 27 October 2026

The owner clarified that the delay is the RGCRM bubble remaining on **sending**. The browser already awaits the send response before showing **sent**; that wait includes server authentication, Meta acceptance and database persistence. Realtime is not required to stop the indicator after a successful HTTP response.

The UI now binds the exact pending bubble to the returned database and WhatsApp message IDs. HTTP-first and Realtime-first arrivals converge to one bubble while preserving delivered/read/terminal failed status. Unrelated incoming messages no longer remove every pending send, and repeated identical outgoing texts are not matched by text. Pending message IDs use UUIDs to avoid collisions between sends within the same millisecond. Confirmed Meta acceptance survives a persistence error; attachment cleanup is restricted to definite client rejections rather than ambiguous transport/server failures.

A fresh read-only check still found live migration history ending at **84**, with `record_whatsapp_outbound` absent. The backend optimization therefore still requires migration 85 and application deployment. These UI changes do not bypass the provider acknowledgment or establish a measured live latency improvement.

## Diagnostics after deployment

Responses expose `Server-Timing` with `auth`, `conversation`, `connection`, `preparation`, `provider`, `persist` and `total`. Plain text additionally separates `allowance` from `meta_http`. `provider` includes those nested spans; do not add every duration together. `meta_http` measures the response-header wait; provider time includes response parsing. Templates/media/interactive sends currently expose the combined provider stage.

`X-Send-Region` identifies the function's actual deployment region. `X-Send-Request-Id` correlates requests with safe slow-request logs emitted after two seconds. Headers and these logs contain durations, status, region and a generated request ID, never message text, phone numbers or tokens. Timings exclude browser network time and function cold startup before handler execution.

In the browser Network panel, inspect a normal text send after rollout:

- Large `auth`, `conversation`, `connection`, `allowance` or `persist`: investigate app-to-Supabase round trips and placement.
- Large `preparation`: investigate template/contact/reservation lookups.
- Large `meta_http`/`provider`: Meta/transport is the slow stage.
- Large browser wait with a small handler `total`: investigate cold starts, middleware/routing, and network.

## Deployment

1. Apply **85_whatsapp_outbound_send_latency.sql before deploying the matching application**. Persistence depends on its RPC.
2. Check Vercel Settings → Functions → Function Regions. Prefer Tokyo (`hnd1`) for this Tokyo database, subject to the hosting plan/settings. No region is hard-coded in application code. Verify the result via `X-Send-Region`. [Vercel region guidance](https://vercel.com/docs/functions/configuring-functions/region).
3. With a designated test number, compare multiple warm sends and a cold send; record median and p95 request timings separately from customer receipt/delivery status. Do not equate Meta acceptance with device delivery.

No live migration/deployment or real Meta send was performed. The exact post-deployment latency is not yet measured; no sub-second or production sign-off claim is made.

## Validation

- Relevant messaging/automation/API/auth/middleware run: **1,213 passed, 125 optional tests skipped**. PostgreSQL suites were run separately.
- Actual PostgreSQL 17: **13 passed**, none skipped, covering atomic persistence, message-ID replay/status ordering, agent handoff, viewer/anonymous/cross-workspace denial, service-role scoping, invalid replies and the existing one-connection/cleanup policy.
- Complete migrations 001–85 replayed in a disposable database; schema/security assertions passed.
- TypeScript, changed-file lint, production webpack build and diff checks passed.

Follow-up validation: Inbox state and relevant send/component/middleware suites passed **119 tests**, with **8 PostgreSQL tests skipped** in that run because the optional database environment was not enabled. The UI state regressions cover both event orders, repeated messages, unrelated inbound events, delivery-status ordering and accepted-but-unsaved responses. No PostgreSQL code changed in this follow-up. TypeScript, the production webpack build, formatting and diff checks passed again. Changed-file lint has no errors and reports two existing warnings in `message-thread.tsx` (unused `ScrollArea` and a missing `tQuote` hook dependency). Browser interaction and real Meta delivery were not tested.
