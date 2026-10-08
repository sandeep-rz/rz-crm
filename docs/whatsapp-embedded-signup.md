# RGCRM WhatsApp Embedded Signup implementation report

Implemented and corrected 2026-10-08. Reconnect and interruption recovery were reviewed and corrected in forward migration 74. Automated implementation checks pass. **Live Meta E2E and deployment approval remain pending.** No remote database migration, Meta configuration change, real onboarding, billing operation, or deployment was performed.

## WABA concurrency and lease review: exact changes

Multiple phone connections may share one WABA **within the same RGCRM workspace**. There is no unique WABA constraint on `whatsapp_config`. [Meta's phone-number collection API](https://www.postman.com/meta/whatsapp-business-platform/request/e9ady51/get-phone-numbers) lists the numbers belonging to a WABA. Cross-workspace WABA/phone ownership protection remains unchanged.

This review changed exactly eight files:

- `supabase/migrations/75_whatsapp_signup_waba_lease_fencing.sql`
- `src/app/api/whatsapp/embedded-signup/route.ts`
- `src/app/api/whatsapp/embedded-signup/route.test.ts`
- `src/lib/whatsapp/embedded-signup.ts`
- `src/lib/whatsapp/embedded-signup.test.ts`
- `supabase/tests/embedded-signup-waba-leases.sql`
- `supabase/tests/embedded-signup-waba-concurrency.py`
- `docs/whatsapp-embedded-signup.md`

Migration 75 is an additional forward correction, applied **after 73 and 74**. It was generated with the Supabase CLI and normalized to this repository's existing sequential migration naming convention. Both earlier migration files remain unchanged. No remote migration or deployment was performed.

The claim RPC now serializes WABA lease acquisition under an advisory transaction lock and rejects another live processing lease for the same WABA. The durable lease covers the HTTP activation interval; the DB transaction stays short. Other WABAs can proceed independently, and another phone on the same WABA can connect after the prior operation completes/releases its lease. This is exclusion of active operations, not a restriction on WABA phone cardinality.

A new service-only `assert_whatsapp_signup_lease` checks lease identity, current processing state, expiry using the database clock, current account/admin authorization, and conflicting WABA leases. Reserve and finalization call it; the backend calls it before activation and immediately before subscription/registration mutations. `mark_whatsapp_registration` atomically writes the encrypted PIN and one durable registration-intent marker under that guard; it cannot overwrite an existing intent even with a reclaimed lease. `release_whatsapp_signup` conditionally releases only the current unexpired lease. Worker paths no longer write registration markers or release leases with direct table updates.

A final read-only `verifySignupActivation` checks the app's actual WABA subscription and the exact phone's CONNECTED state **after any registration operation**. Only after that check and another lease guard does the backend call `finish_whatsapp_signup`, passing server-generated verification timestamps. If any Meta check or lease guard fails, finalization is not called. Reconnect preservation and encrypted pending credential staging are unchanged.

A reclaimed lease reuses pending encrypted credentials and the existing registration marker. A CONNECTED phone needs no registration POST. When an earlier registration intent has an uncertain outcome and the phone is still not CONNECTED, recovery stops for reconciliation instead of issuing another registration POST. The marker is retained on failure and interruption. These controls do not make an already-dispatched Meta HTTP call transactional with PostgreSQL; they fence database writes and block new stale-worker mutations at their dispatch guards.

Validation for this review: **9 focused test files, 99 tests passed; typecheck and scoped lint passed**. Disposable PostgreSQL assertions passed for WABA exclusion, multiple numbers sharing a WABA, independent WABAs, expired/reclaimed/stale leases, one-time registration intent, recovery, full-row reconnect preservation, tenant protection and restricted grants. A separate two-session race held the first WABA claim transaction open while a second phone attempted a claim: the second waited for the advisory lock and then received WABA-busy, with exactly one live lease. This fixture uses a minimal canonical table model, not the entire historical Supabase migration chain. Live Meta behavior remains untested.

Run the SQL fixture only in a fresh disposable database, then the concurrency runner with the same explicit PG settings:

```sh
psql -v ON_ERROR_STOP=1 -f supabase/tests/embedded-signup-waba-leases.sql
python3 supabase/tests/embedded-signup-waba-concurrency.py
```

Set `PGDATABASE` explicitly for the Python runner. Deploy the corrected backend together with migration 75, quiescing the old signup endpoint during the transition. No frontend, automation, broadcast, semantic messaging or PMS module was changed in this review.

## Prior reconnect/recovery correction: exact files in that review

The prior reconnect/recovery review changed these nine files:

- `src/lib/whatsapp/embedded-signup.ts`
- `src/lib/whatsapp/embedded-signup.test.ts`
- `src/app/api/whatsapp/embedded-signup/route.ts`
- `src/app/api/whatsapp/embedded-signup/route.test.ts`
- `src/components/settings/whatsapp-embedded-signup.tsx`
- `src/components/settings/whatsapp-embedded-signup.test.tsx`
- `supabase/migrations/74_whatsapp_signup_safe_reconnect.sql` (new forward correction)
- `supabase/tests/embedded-signup-reconnect.sql` (new disposable database regression fixture)
- `docs/whatsapp-embedded-signup.md`

Migration 73 is preserved. Apply 74 after 73 and deploy the corrected handler together, briefly quiescing the old signup endpoint during the transition because RPC signatures change. No migration was applied to a remote database. The existing auxiliary attempt ledger holds staged encrypted credentials and a short request lease; no new connection model or generic workflow engine was introduced.

## Existing architecture and reuse

This checkout is the customized WACRM/RGCRM Next.js 16 application, despite the supplied generic Rukiye Zara monorepo instructions. Settings is implemented in `src/components/settings/whatsapp-config.tsx`, with manual wizard/cards in `whatsapp-setup-ui.tsx`. Connections are one-to-many workspace children in `whatsapp_config`; `phone_number_id` is globally unique. Existing RLS permits settings writes to account admins/owners.

`requireRole('admin')` resolves the authenticated user, active profile account and role. Token encryption reuses the existing AES-256-GCM implementation. WABA number listing, subscription and subscribed-app discovery reuse `meta-api.ts`; optional abort signals were added without changing existing callers. The existing Graph API version remains v21.0; Embedded Signup v4 is selected by the Login for Business configuration, independently of Graph API version.

The dashboard-owned `WhatsAppCapabilityProvider` remains the shared state source. Signup refreshes it on success and on partial failure. Explicit reconnect also reloads the managed connection. Normal Settings reads use stored metadata, with no Meta verification call.

The unchanged `/api/whatsapp/webhook` verifies Meta signatures and resolves inbound messages/statuses through the canonical phone-number connection/account mapping. No duplicate webhook, message API, capability provider, or connection table was created. Manual setup, verification, primary selection and existing deletion remain available.

## Exact changed files

| File                                                        | Change                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `.env.local.example`                                        | Optional dedicated onboarding secret guidance                              |
| `next.config.ts`                                            | Facebook SDK/connect/frame origins in existing report-only CSP             |
| `src/app/api/whatsapp/config/route.ts`                      | Allowlisted safe onboarding summary in local GET                           |
| `src/app/api/whatsapp/embedded-signup/route.ts`             | Authenticated start/completion endpoint                                    |
| `src/app/api/whatsapp/embedded-signup/route.test.ts`        | Route security, duplicate and failure tests                                |
| `src/components/settings/whatsapp-config.tsx`               | Embedded Signup primary entry, advanced manual setup, reconnect            |
| `src/components/settings/whatsapp-config.test.tsx`          | Existing manual regression uses advanced entry                             |
| `src/components/settings/whatsapp-setup-ui.tsx`             | Number/account, subscription and payment summary                           |
| `src/components/settings/whatsapp-embedded-signup.tsx`      | SDK loading, popup/callback coordination and recovery UI                   |
| `src/components/settings/whatsapp-embedded-signup.test.tsx` | Both callback orders, long interaction, cancellation, recovery and refresh |
| `src/lib/whatsapp/config-state.ts`                          | Safe optional onboarding summary type                                      |
| `src/lib/whatsapp/meta-api.ts`                              | Optional cancellation signals for three existing read/setup helpers        |
| `src/lib/whatsapp/embedded-signup-context.ts`               | Public app/config constants and strict origin/event/ID parsing             |
| `src/lib/whatsapp/embedded-signup.ts`                       | Server code exchange, authorization validation and setup verification      |
| `src/lib/whatsapp/embedded-signup.test.ts`                  | Mocked Meta, encryption, permission and registration tests                 |
| `supabase/migrations/73_whatsapp_embedded_signup.sql`       | Durable attempts, metadata/PIN columns and atomic reservation/finalization |
| `supabase/migrations/74_whatsapp_signup_safe_reconnect.sql` | Safe staged reconnect, fenced recovery and atomic promotion                |
| `supabase/tests/embedded-signup-reconnect.sql`              | Disposable PostgreSQL migration/reconnect/security fixture                 |
| `docs/whatsapp-embedded-signup.md`                          | This report and deployment/E2E guide                                       |

No resolver, compiler, send path, automation, broadcast, PMS, MCP or public API implementation changed.

## Endpoint and persistence

One new authenticated endpoint: `POST /api/whatsapp/embedded-signup`.

- `{ action: 'start', reconnect_id?: UUID }` creates a user/account-bound attempt and returns its ID plus public configuration. Reconnect requires an owned existing connection.
- `{ action: 'complete', session_id, code, context: { waba_id, phone_number_id } }` validates and completes it. No client token is accepted as proof.
- `{ action: 'recover', session_id }` or `{ action: 'recover', connection_id }` reuses this user's staged encrypted credentials without a fresh authorization code. Connection-based recovery supports a page reload or process restart. The same endpoint revalidates the token, WABA/phone ownership and actual Meta activation state.
- Same-origin requests and admin/owner privileges are mandatory. Set `NEXT_PUBLIC_SITE_URL` to the exact externally visible HTTPS origin behind a proxy.
- Interactive attempts and staged recovery expire after 24 hours. There is no frontend deadline on the interactive Facebook signup; explicit cancellation remains available. Network/SDK loads retain bounded timeouts. A best-effort guard limits starts to ten per user in a ten-minute window; this is not a distributed abuse-control system.
- A service-only claim RPC leases the attempt before exchanging the one-use code. A three-minute lease fences concurrent/stale requests, exceeding the 120-second endpoint execution limit. A process interruption permits recovery after the lease expires; handled failures release their own lease immediately. Only a SHA-256 code digest is stored, with a global unique constraint. Identical completed callbacks return the previous result. Staged attempts are recovered without repeating the code exchange. Concurrent callbacks return 409 and cannot exchange the code twice.
- The server validates app identity, SYSTEM_USER token type, both WhatsApp permissions, token/data-access expiry, readable WABA metadata and WABA phone membership.
- Before subscription/registration, the service-only reservation RPC locks the attempt and serializes workspace/WABA reservations. It rejects foreign WABAs, foreign phones, implicit replacement, mismatched reconnect numbers, and a second candidate while recoverable credentials exist. The existing globally unique phone constraint remains the final race guard. Recovery and finalization also check the original connection updated_at snapshot, so intervening manual changes cannot be silently overwritten.
- Reconnect can replace only the same account-owned connection and same WABA/phone pair. It is explicitly labelled as a credential replacement action in the UI.
- Tokens use the existing encryption function. Replacement credentials/metadata are staged in the attempt ledger; reserving an existing connection changes **none** of its live fields. Its token, status, connected_at, registered_at, subscribed_apps_at, PIN and metadata stay intact if activation or finalization fails. A new connection is initially disconnected. Only after verified app subscription and CONNECTED phone state does atomic finalization promote staged credentials and update verification timestamps. Completed staging secrets are cleared.
- Activation first reads subscribed apps. It subscribes only when our app is absent, then verifies the resulting subscription. It reads phone state and skips registration when CONNECTED. A new registration PIN is encrypted and stored in the attempt before the POST, alongside a durable request marker. After an interrupted registration, recovery rechecks Meta; an unknown outcome with a non-CONNECTED phone is verification-only and never blindly re-POSTs. Resolve that state in WhatsApp Manager and retry recovery. Raw Meta exceptions and sensitive request data are never logged or returned.
- After Meta success but DB failure, staged credentials remain available. Use Recover saved setup: token/asset authorization is revalidated, current subscription and phone state are read, already-completed external operations are skipped, and DB finalization is retried. A new authorization exchange is only necessary when no candidate was durably staged, its recovery window expired, or its token is no longer authorized. An interruption between Meta issuing a token and durable staging cannot recover a token the server never saved. Working reconnect targets remain intact throughout.
- Migration 74 backfills recoverable migration-73 partial attempts from the encrypted credentials already saved in their connection. Legacy registration outcome is treated as unknown. It cannot reconstruct a previously overwritten token or original verification timestamps; recovering old damage requires valid remaining credentials, a backup, or explicit new authorization.

Migration 73 is required because the existing connection schema has no durable signup-attempt/replay state or onboarding metadata. `whatsapp_signup_attempts` is an auxiliary attempt ledger, **not a connection table**. It has RLS enabled, no browser-role privileges/policies, and service-role-only access. All signup RPCs are service-role-only and independently recheck the stored user's current account/admin role. Connections remain in `whatsapp_config`. The SQL fixture applies migrations 73 and 74 to a minimal canonical-table model; it does not replay the complete historical Supabase migration chain.

Operational retention: incomplete-attempt expiry is enforced when claiming setup/recovery; completed callbacks remain idempotent. No additional scheduler was introduced. Operators may remove old attempt-ledger rows through their existing database maintenance process after their audit-retention period; code hashes must remain for the 24-hour staging/recovery window. Treat encrypted tokens/PINs as secrets in backups. Never enable request-body or unredacted outbound Graph URL logging: Meta's standard debug-token GET contains `input_token` in its query.

## Environment and Meta prerequisites

Existing variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` (64 hex characters), `META_APP_SECRET`, and the canonical `NEXT_PUBLIC_SITE_URL`.

Optional new server-only variable: `META_EMBEDDED_SIGNUP_APP_SECRET`. Use it if the existing webhook secret setting contains multiple comma-separated app secrets. It must be the **single secret for app 1444327167651307**, and must also appear in `META_APP_SECRET` so incoming webhook signatures can be accepted. Without the dedicated setting, onboarding uses a single `META_APP_SECRET`. The server rejects ambiguous/missing secrets or an onboarding secret absent from the webhook secret list. Restart after environment changes.

Public configuration is fixed to the supplied App ID `1444327167651307` and TechConfig ID `1392665409205658`. Launch uses `response_type: code`, `override_default_response_type: true`, and `extras: { setup: {} }`, matching Meta’s current standard v4 implementation example. Product selection and v4 are driven by the Login for Business configuration. The browser SDK initializes with `v26.0`, matching the generated snippets in the supplied Meta app dashboard screenshot. Existing backend Graph calls remain on v21.0. No app secret or business token is shipped to the browser.

Verify in the actual Meta dashboard before rollout:

1. App is Live and belongs to the intended verified business; required Tech Provider enrollment/access verification and App Review/Advanced Access are approved for customer asset onboarding.
2. TechConfig is genuinely a Facebook Login for Business **Embedded Signup v4** configuration for WhatsApp Cloud API, issuing a business integration system-user token with `whatsapp_business_management` and `whatsapp_business_messaging`, and the intended customer asset access/token lifetime.
3. The exact production HTTPS host is configured in App Domains and the applicable Facebook Login for Business allowed SDK/login/OAuth settings. Privacy policy, terms and data-deletion settings satisfy Meta's app requirements.
4. Verify the supplied v4 configuration returns the FINISH session payload with WABA/phone IDs plus the SDK code callback. This combination has not been verified live. Supported completion is the standard Cloud API FINISH flow; coexistence/history-sync and WABA-only flows are not enabled by this implementation and must not be selected in TechConfig without separate support and testing.
5. The existing app webhook points to `https://<RGCRM-host>/api/whatsapp/webhook`, is verified, and subscribes to required messages/status fields. Its app secret matches the onboarding app.
6. Customer-direct payment setup is enabled in the intended onboarding arrangement. Do not attach RGCRM credit or select a partner-funded billing configuration.
7. Hosting permits up to 120 seconds for this route. Outbound Meta operations are bounded; interactive popup waiting has no client deadline; inspect platform timeout settings separately.

Meta’s public implementation, v4 and FedCM documentation were retrieved on 9 October 2026. This verifies the documented launch format, not this app’s private configuration, provider approval, billing eligibility or live signup success. Review [Meta Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/), [Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider), and [Meta's official API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/du6gzjv/embedded-signup) during the live gate.

## Customer billing

RGCRM performs no credit-line sharing, credit attachment, payment-method configuration, usage charging or SaaS billing mutation. UI explicitly tells customers that Meta usage is billed directly and SaaS charges are separate. It links to WhatsApp Manager and asks them to select the WABA and configure Payment settings. Stored billing status is always `not_verified`; successful onboarding never sets billing ready. Whether the live TechConfig/customer arrangement actually bills directly must be checked in Meta; code alone cannot establish that.

## Tests and evidence

- Correction focused suite: **9 files, 90 tests passed**. Coverage includes failed reconnect preservation, successful promotion, DB finalization failure and recovery without exchange, interrupted recovery with a saved registration marker, already-active Meta reconciliation without POSTs, unknown registration outcome protection, signup lasting five minutes, explicit cancellation, tenant protection, existing manual configuration and shared capability behavior.
- TypeScript `tsc --noEmit`: passed.
- Correction scoped ESLint: passed. The prior repository-wide ESLint run reported one pre-existing error in unchanged `src/app/(dashboard)/contacts/page.tsx:266` (`react-hooks/set-state-in-effect`) and 26 warnings in unchanged files. No unrelated lint fixes were made.
- PostgreSQL: migrations 73 and 74 applied successfully in a fresh disposable local database. Full-row preservation after failed reconnect, successful credential promotion, finalization rejection, interrupted recovery, stale-lease fencing, manual-change conflict, foreign WABA/phone, current role/account checks, service-only grants and legacy-attempt backfill passed.
- Prior broader suite checkpoint (before this correction; not rerun for these scoped fixes): **175 files passed, 1 failed, 5 skipped; 2,099 tests passed, 6 failed, 65 skipped**. All six failures are in unchanged `src/i18n/messages.test.ts` and unchanged translation catalogs: missing `Flows.builder.form.bodyTextPlaceholder`, three `Settings.templates` keys, and invalid translated ICU for `Settings.templates.bodyPlaceholder` in ko/pt/es. These pre-existing unrelated files were not edited.
- Initial shell Node 20.17 could not run jsdom's ESM dependency. The bundled newer Node runtime ran the focused correction suite and prior broader suite successfully apart from the catalog failures above; use a current supported Node runtime.
- `git diff --check`: passed.
- Not tested: real Facebook SDK network/popup behavior, the supplied app/configuration, actual OAuth exchange and BISU response, full deployed Supabase schema/RLS through PostgREST, real Meta phone status/registration, real webhook deliveries/status routing for a newly onboarded number, customer payment method/readiness, or production proxy/CSP behavior. Existing webhook routing was inspected and existing webhook behavior remains unchanged.

Reproduce focused checks with a supported Node runtime:

```sh
npx vitest run src/lib/whatsapp/embedded-signup.test.ts src/components/settings/whatsapp-embedded-signup.test.tsx src/components/settings/whatsapp-config.test.tsx src/app/api/whatsapp/config src/app/api/whatsapp/embedded-signup/route.test.ts src/lib/whatsapp/meta-api.test.ts src/lib/whatsapp/meta-api.typing.test.ts src/lib/whatsapp/capability-ui-contract.test.ts src/hooks/use-whatsapp-capability.test.tsx
npm run typecheck
npm run lint
```

For the current SQL checks, create a **fresh disposable local database** and run `psql -v ON_ERROR_STOP=1 -f supabase/tests/embedded-signup-waba-leases.sql`. Do not run that fixture against an existing app database.

## Exact live E2E rollout gate

1. Apply migration 73, correction 74 and WABA lease correction 75 to DEV through the existing migration workflow, verify the new columns/table/RPC grants, set the server secrets and canonical HTTPS site URL, restart, and check Meta prerequisites above. Preserve a known working manual connection for comparison. Do not perform this first on production.
2. Sign in as a workspace admin. Open Settings → WhatsApp → Connect WhatsApp, then Continue with Facebook. Confirm the popup opens directly from the click; cancel once and verify no connection is created and no code/token appears in browser/server logs.
3. Repeat, complete TechConfig with a customer-controlled test business/WABA and permitted phone, and confirm both the session FINISH event and code callback complete regardless of order. Do not copy the code/token into logs or test evidence.
4. Confirm one `whatsapp_config` row with the correct account, WABA and phone, encrypted access token, connected status, registration/subscription timestamps, safe display number/account metadata, and `billing_status: not_verified`. Confirm any generated registration PIN is encrypted and absent from config GET and browser responses. Confirm sidebar/capability availability refreshes without reload.
5. Send an inbound test WhatsApp message from a controlled device. Confirm the existing webhook routes it into that workspace and selected connection. Send a controlled reply through the existing UI, confirm delivery/read status updates route to the same connection, and verify another workspace cannot read either conversation. These are explicitly live tests, not changes to sending code.
6. Repeat the identical completion request within the recovery window using an authorized local test harness without logging the body; expect the same connection ID and no second exchange/setup. Concurrent submission while processing must return 409. After an interrupted process, wait for the three-minute lease to expire and use Recover saved setup. Staged recovery expires after 24 hours.
7. Attempt to connect the same phone from another workspace; expect conflict and no subscription/registration call after reservation rejection. Test a new phone under the same already-owned WABA from another workspace; expect conflict. Try forged IDs outside the granted WABA; expect validation failure.
8. In the original workspace, attempt ordinary signup for the existing number; expect protection. Open Manage → Reconnect WhatsApp and explicitly authorize the same number; expect credential refresh of the same row. Selecting a different number/WABA during reconnect must fail.
9. Use controlled DEV API mocking/proxy failures to reject subscription/registration after reservation on an existing working connection. Confirm its full live row, token and verification timestamps are unchanged. Recover saved setup and verify completion. Simulate subscription and registration success followed by DB finalization failure; recover without another code exchange and confirm no repeated subscription/registration POST. Repeat after restarting the process and after reloading the page. Test an already CONNECTED phone and verify `/register` is skipped; for a pending number verify encrypted PIN persistence before registration and the final CONNECTED check. Never deliberately disrupt a live customer number.
10. Block Facebook popups/SDK once, close the popup once, and try incomplete setup/missing assets. Leave interactive signup open longer than two minutes, then complete it. Confirm actionable network failure/cancellation messages and explicit cancellation and ability to start again. Refresh/switch workspace mid-flow; completion must stay bound to the original authorized user/account and must not display stale state in another workspace.
11. Open the customer's selected WABA in WhatsApp Manager → Payment settings. Verify/add the **customer's** payment method and confirm the intended Meta payer in Meta itself. RGCRM must continue to show payment readiness as unverified; verify no RGCRM credit line was shared/attached.
12. Recheck the preserved manual connection, advanced manual add/save, explicit verification, primary selection, existing disconnect/delete behavior and inbound routing. Confirm routine Settings loads perform only local config reads. Record Meta app/config ID, safe connection IDs, timestamps and outcomes; never record tokens/codes/secrets.

Do not describe the integration as live production-verified until this gate passes.

## Saved setup discovery and explicit abandonment

Apply forward migration **76_whatsapp_signup_abandonment.sql** after 73–75 before deploying these changes. It adds only `discarded_at` to the existing attempt table and a service-only atomic discard RPC; no new tables or connection architecture.

WhatsApp Settings performs a local, uncached GET to the existing Embedded Signup endpoint for admins/owners. The backend scopes attempts to the authenticated user and current workspace and returns safe summaries only. Unexpired staged credentials offer **Recover saved setup**, including after refresh and before a connection has completed. Unfinished sessions without reusable authorization and expired sessions can be discarded. Active leases disable recovery/discard in the UI and the database rejects concurrent discard. Reload after an interrupted worker's three-minute lease expires.

**Cancel signup** only stops the current browser interaction. It never discards a durable attempt. **Discard saved setup** requires an explicit confirmation, revokes that attempt's recovery and clears staged encrypted credentials. It does not alter/delete `whatsapp_config`, reverse Meta operations, disconnect a working number, or remove registration intent history. If a discarded attempt had an uncertain registration outcome, future setup must observe the phone as CONNECTED in Meta before completion; another registration POST is blocked until that external outcome is resolved. Existing working credentials and verification timestamps remain unchanged.

Embedded Signup cards now distinguish **Setup incomplete** from **Connected · verified during setup** (historical verification, not a live health claim). Manual setup, billing guidance, reconnect, connection management and the shared WhatsApp capability provider remain in place.

Focused coverage includes browser refresh discovery, connectionless attempts, identity/workspace changes and late responses, confirmation and cancellation, admin authorization, active leases, stale workers, uncertain registration and byte-for-byte working connection preservation. Run `supabase/tests/whatsapp_signup_abandonment.sql` against the disposable signup database fixture after migrations 73–76; it rolls back its assertions. The first live Meta signup and deployment remain separate steps.

Files changed for the saved-setup review (earlier signup work remains intact):

- `src/app/api/whatsapp/embedded-signup/route.ts`
- `src/app/api/whatsapp/embedded-signup/discovery.test.ts`
- `src/components/settings/whatsapp-config.tsx`
- `src/components/settings/whatsapp-config.test.tsx`
- `src/components/settings/whatsapp-embedded-signup.tsx`
- `src/components/settings/whatsapp-embedded-signup.test.tsx`
- `src/components/settings/whatsapp-setup-ui.tsx`
- `src/components/settings/whatsapp-setup-ui.test.tsx`
- `src/hooks/use-saved-whatsapp-signups.ts`
- `src/hooks/use-saved-whatsapp-signups.test.tsx`
- `src/lib/whatsapp/embedded-signup-context.ts`
- `supabase/migrations/76_whatsapp_signup_abandonment.sql`
- `supabase/tests/whatsapp_signup_abandonment.sql`
- `docs/whatsapp-embedded-signup.md`

## Popup launch investigation — 9 October 2026

**Confirmed frontend defect:** the old loader treated the outer `sdk.js` script’s `onload` plus existence of `window.FB` as readiness. Meta’s public bootstrap script creates a buffering `FB` object (`__buffer`) and loads a second bundle. The full bundle later replaces `window.FB`. RGCRM could therefore call the stub’s `init`, resolve/cache that stub and save it in `prepared.fb`. Continue then called the stale object’s buffered `login`, never the full SDK’s login method. Its queue might already have been replayed, or be replayed asynchronously outside the original user interaction. This explains a successful backend session and a waiting UI without a popup. A focused regression reproduces this sequence and asserts the corrected behavior.

Sources inspected directly: [Meta bootstrap SDK](https://connect.facebook.net/en_US/sdk.js), [full SDK bundle](https://connect.facebook.net/en_US/bundle/sdk.js/), [Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/), [v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4/), and [Facebook Login FedCM](https://developers.facebook.com/documentation/facebook-login/web/fedcm/).

The corrected trace is:

1. **Connect WhatsApp** prepares the flow: wait for the real SDK’s `fbAsyncInit`, initialize the full object, then create the existing authorized backend session. A buffered pre-existing SDK cannot pass readiness or cause a duplicate script injection. SDK load/error and initialization failures remain bounded and visible.
2. Only after SDK initialization and session creation does **Continue with Facebook** become available.
3. The real Continue click calls `FB.login` synchronously. React state setters, a timer cleanup and development-only console diagnostics are synchronous; there is no `await`, fetch, promise continuation or `setTimeout` between this click and `FB.login`. Tests assert login is invoked before the click returns and without another request.
4. After the login invocation returns, a ten-second watchdog may change a silent launch to **Check Facebook popup**, with retry/cancel guidance. It does not invalidate the current callback, discard a durable attempt, close an open popup or impose a timeout on interactive signup. Late completion still works. Receiving only one half of the completion pair also shows an actionable status without a permanent spinner.
5. Login callback errors, empty callbacks, exceptions, trusted Meta cancellation/error events and explicit UI cancellation clear the launch state. Retry reuses the prepared session and ignores earlier login callbacks. Unmount and cancellation clear the watchdog.

The standard v4 launch now uses `extras: { setup: {} }`, matching Meta’s current implementation page. The earlier screenshot-derived `version: "v4"` and legacy `sessionInfoVersion` launch fields were removed. The actual checkout already had browser SDK `v26.0`; this investigation makes **no SDK/Graph version change**. Backend Graph calls stay v21.0. If the running start response still reports browser SDK v21.0, compare it with this checkout’s configuration and deploy/reload the intended build; an old response does not prove which SDK the current browser loaded.

Meta’s current FedCM documentation says Login for Business configuration support is planned, not supported yet. The public SDK bundle confirms that `fedCM: false` explicitly selects the existing popup flow and prevents a cached app-config default from opting in. Initialization now sets that flag; no permissions or security headers are weakened.

Repository security inspection found report-only CSP, with the Facebook SDK script, connection and frame hosts already allowed. Report-only CSP does not itself block login. No project COOP header was found. Actual deployed/CDN headers, browser extensions, domain allowlists and popup restrictions still require live browser evidence. Meta requires the actual launching domain in the Login for Business SDK/allowed-domain and OAuth settings; allowing popups alone does not verify those settings. No SDK window-open interception, alternate OAuth URL, new backend endpoint or credential/browser bypass was introduced.

Development-only logs use the prefix `[WhatsApp Embedded Signup]` and record script load, real `FB.init` completion, ready state/config version, `FB.login` invocation/user activation, callback presence, vetted `WA_EMBEDDED_SIGNUP` event names, secure-context/top-level checks, CSP directive/enforcement violations (never blocked URLs), and cancellation/error/unconfirmed-launch milestones. They never log raw SDK responses, event data, OAuth codes, access tokens or exception messages. Production emits none of these diagnostic logs. Filter the console by that prefix during the next DEV test.

Validation: frontend regression tests cover the real bootstrap/full-SDK handoff, disabled Continue while the SDK is buffered, SDK timeout/init failure, synchronous login invocation, callback exceptions/errors, silent-launch status, long-running late success, retry, cancellation and safe development/production logs. No live popup or authenticated customer onboarding was performed. Backend signup, exchange, registration, reconciliation, webhook, billing and connection architecture remain unchanged; no migration is needed.

Files changed for this popup investigation:

- `src/components/settings/whatsapp-embedded-signup.tsx`
- `src/components/settings/whatsapp-embedded-signup-sdk.test.tsx`
- `src/components/settings/whatsapp-embedded-signup.test.tsx`
- `src/lib/whatsapp/embedded-signup-diagnostics.ts`
- `docs/whatsapp-embedded-signup.md`
