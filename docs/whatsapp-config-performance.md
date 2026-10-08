# WhatsApp Configuration Performance and Shared-State Cleanup

## 1. Root cause

The previous normal `GET /api/whatsapp/config` performed these sequential stages:

1. Create the cookie-authenticated Supabase client and call `auth.getUser()`.
2. Read `profiles.account_id` for the authenticated user.
3. Read all account-owned connections, including encrypted access and verification tokens, ordered by primary and creation time.
4. Build a safe connection collection locally and resolve the selected/primary connection.
5. Decrypt the selected connection's access token.
6. Await Meta phone metadata verification.
7. Then await Meta WABA subscription lookup, when a WABA ID exists.
8. Enrich the selected display name from live phone metadata and return health information.

Only the selected connection was probed; the collection mapping did not probe every row. However, independently mounting consumers repeated this entire operation. Inbox also independently resolved session/profile before calling an endpoint that did its own authentication/account resolution. The dashboard separately requested capability.

Auth and database requests also contribute latency. No authenticated live timing trace was captured, so this report does not attribute a measured percentage of the reported 8–10 seconds to any stage or promise a new millisecond SLA. Source inspection and instrumentation tests establish the avoidable sequential external work and duplicate requests. Tests verify the revised GET completes without invoking Meta, including when the mocked verification function would never resolve. No timing logs were added to production.

## 2. Previous request map

| Independent caller                   | Previous request behavior                                                   |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Automation connection bootstrap hook | Normal config GET on each new/edit page mount                               |
| Flows list                           | Config GET alongside flow/template requests                                 |
| Flow editor header                   | Config GET on mount                                                         |
| Broadcast creation                   | Config GET after capability became available                                |
| Template Manager                     | Config GET before querying templates                                        |
| Inbox page                           | Session/profile lookup, then config GET                                     |
| Inbox Template Picker                | Config GET when no conversation connection was supplied                     |
| Settings overview                    | Separate config GET for live connection status                              |
| WhatsApp Settings                    | Config GET on initial hydration, connection management, mutations, and Test |
| Dashboard capability provider        | Separate `/api/whatsapp/capability` request                                 |

Other capability consumers—sidebar, message composer, Broadcast list/detail, Flow editor/runs and capability gates—already shared the provider and now receive its locally derived capability without another endpoint request.

## 3. Files changed

| File                                                                                                                                                       | Purpose                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/app/api/whatsapp/config/route.ts](/Users/mac/Downloads/rz-crm/src/app/api/whatsapp/config/route.ts)                                                   | Replace normal GET health probing with an authenticated, account-filtered local read and explicit safe response. Preserve setup/update/delete handlers.                                 |
| [src/app/api/whatsapp/config/verify-registration/route.ts](/Users/mac/Downloads/rz-crm/src/app/api/whatsapp/config/verify-registration/route.ts)           | Reuse explicit diagnostics for credential testing; return phone metadata, subscription detail, check timestamp, and actionable credential/decryption failures.                          |
| [src/hooks/use-whatsapp-capability.tsx](/Users/mac/Downloads/rz-crm/src/hooks/use-whatsapp-capability.tsx)                                                 | Extend the existing dashboard provider with shared connections, primary selection, account/user isolation, request deduplication, background refresh, and invalidation.                 |
| [src/lib/whatsapp/config-state.ts](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/config-state.ts)                                                           | Define the credential-free UI connection and local response types.                                                                                                                      |
| [src/hooks/use-automation-whatsapp-connections.ts](/Users/mac/Downloads/rz-crm/src/hooks/use-automation-whatsapp-connections.ts)                           | Replace independent bootstrap fetch with the shared provider snapshot.                                                                                                                  |
| [src/app/(dashboard)/dashboard-shell.tsx](</Users/mac/Downloads/rz-crm/src/app/(dashboard)/dashboard-shell.tsx>)                                           | Show a non-destructive shared configuration error/retry notice.                                                                                                                         |
| [src/app/(dashboard)/flows/page.tsx](</Users/mac/Downloads/rz-crm/src/app/(dashboard)/flows/page.tsx>)                                                     | Consume shared connections; remove config from the page request batch.                                                                                                                  |
| [src/components/flows/header.tsx](/Users/mac/Downloads/rz-crm/src/components/flows/header.tsx)                                                             | Consume shared connection options instead of fetching on mount.                                                                                                                         |
| [src/app/(dashboard)/broadcasts/new/page.tsx](</Users/mac/Downloads/rz-crm/src/app/(dashboard)/broadcasts/new/page.tsx>)                                   | Consume shared connections and derive the default from the current primary.                                                                                                             |
| [src/app/(dashboard)/inbox/page.tsx](</Users/mac/Downloads/rz-crm/src/app/(dashboard)/inbox/page.tsx>)                                                     | Replace independent session/profile/config bootstrap with shared local availability and connections.                                                                                    |
| [src/components/inbox/template-picker.tsx](/Users/mac/Downloads/rz-crm/src/components/inbox/template-picker.tsx)                                           | Use shared primary fallback instead of another config GET.                                                                                                                              |
| [src/components/settings/template-manager.tsx](/Users/mac/Downloads/rz-crm/src/components/settings/template-manager.tsx)                                   | Use shared connections and selected identity; retain its own template queries.                                                                                                          |
| [src/components/settings/settings-overview.tsx](/Users/mac/Downloads/rz-crm/src/components/settings/settings-overview.tsx)                                 | Remove independent live-health fetch; show local configured state explicitly.                                                                                                           |
| [src/components/settings/whatsapp-config.tsx](/Users/mac/Downloads/rz-crm/src/components/settings/whatsapp-config.tsx)                                     | Hydrate from shared data, invalidate after successful mutations, move Test to explicit verification, separate unchecked/live health from configuration, and label registration history. |
| [src/components/settings/whatsapp-setup-ui.tsx](/Users/mac/Downloads/rz-crm/src/components/settings/whatsapp-setup-ui.tsx)                                 | Use safe connection type and label local connection state Configured.                                                                                                                   |
| [src/app/api/whatsapp/config/local-config.test.ts](/Users/mac/Downloads/rz-crm/src/app/api/whatsapp/config/local-config.test.ts)                           | Test local-only reads, no decryption/Meta requests, account ownership, secret exclusion, and error/no-config distinction.                                                               |
| [src/app/api/whatsapp/config/verify-registration/route.test.ts](/Users/mac/Downloads/rz-crm/src/app/api/whatsapp/config/verify-registration/route.test.ts) | Test explicit verification, local registration distinction, ownership, decryption and Meta failures, and unchanged persisted state.                                                     |
| [src/hooks/use-whatsapp-capability.test.tsx](/Users/mac/Downloads/rz-crm/src/hooks/use-whatsapp-capability.test.tsx)                                       | Test concurrent/StrictMode deduplication, cached navigation, refresh failures, account races, invalidation races, disconnects, and multiple/primary connections.                        |
| [src/components/settings/whatsapp-config.test.tsx](/Users/mac/Downloads/rz-crm/src/components/settings/whatsapp-config.test.tsx)                           | Test actual setup, delete, primary and media interactions and invalidation, initial Settings behavior, and explicit verification.                                                       |
| [src/hooks/use-automation-whatsapp-connections.test.tsx](/Users/mac/Downloads/rz-crm/src/hooks/use-automation-whatsapp-connections.test.tsx)               | Exercise builder bootstrap through the shared provider.                                                                                                                                 |
| [src/components/inbox/template-picker.test.tsx](/Users/mac/Downloads/rz-crm/src/components/inbox/template-picker.test.tsx)                                 | Supply shared configuration in existing picker tests.                                                                                                                                   |
| [src/lib/whatsapp/capability-ui-contract.test.ts](/Users/mac/Downloads/rz-crm/src/lib/whatsapp/capability-ui-contract.test.ts)                             | Verify migrated consumers have no independent normal config fetch.                                                                                                                      |
| [docs/whatsapp-config-performance.md](/Users/mac/Downloads/rz-crm/docs/whatsapp-config-performance.md)                                                     | Record the investigation, implementation, invalidation map, and verification limits.                                                                                                    |

No schema changes, migrations, dependencies, automation engine changes, resolver/compiler changes, send-path changes, or worker changes were introduced.

## 4. Final server architecture

Normal configuration: authenticated user → active profile/account → one account-filtered connection query → explicitly shaped UI response. It performs zero Meta calls and no token decryption. It does not select access tokens. The encrypted webhook verification token is read only to produce the existing `has_verify_token` boolean; its value never leaves the server. Responses use `Cache-Control: private, no-store`.

The normal response contains `account_id`, `configured`, `connections`, and `selected_connection_id`. A local collection without a primary is returned successfully; no connection is guessed when multiple rows lack a primary. Explicit IDs are restricted to the authenticated account's collection.

The old top-level live `connected`, `phone_info`, and `waba_subscription` response fields were removed from normal GET rather than silently redefined. All discovered UI consumers were migrated.

Explicit health: Settings Test and Verify registration call the existing `/config/verify-registration` endpoint. It alone decrypts the saved access token and checks Meta. It returns diagnostics, phone metadata, subscription detail, and a check timestamp. Credential/decryption errors remain actionable. This operation does not write lifecycle status or registration timestamps.

Semantics remain distinct:

- `configured`: a local configuration record exists.
- `available`: at least one locally `connected` row has a nonempty phone-number identity; this preserves the capability gate's local lifecycle criteria.
- Connection `status`: persisted lifecycle state, not a live health probe.
- `registered_at` / `subscribed_apps_at`: recorded successful setup operations, not proof that Meta confirmed them during navigation.
- Explicit `verified`: the phone metadata/credential check succeeded during this diagnostic request.
- Explicit `live`: the existing diagnostic combination of phone/subscription checks and recorded registration. It is not an end-to-end delivery test.
- Subscription `app_id_match` remains separate from the existing any-app `subscribed` result.

No global `healthy`, `registered`, `subscribed`, or `verified` flags are fabricated from row existence.

## 5. Final client architecture

`DashboardShell → existing WhatsAppCapabilityProvider → one local config request → useWhatsAppCapability()`.

The provider now exposes local connections, primary connection, configured/available state, loading/error/refreshing state, `refresh()`, and `invalidate()`. Existing capability consumers retain their hook. The automation bootstrap hook delegates to it. No overlapping provider or new fetching library was added.

## 6. Account scoping

The in-memory snapshot/request identity includes authenticated user ID and active account ID. Data is exposed only when its key matches the current identity. A workspace change hides the previous snapshot immediately; late responses for the old account cannot publish into the new account. The returned server account ID is independently checked. A mismatched response clears cached connection data rather than exposing another workspace's collection.

Sign-out clears state. The existing account-switch flow also reloads the document, discarding tenant caches/subscriptions. State is not persisted in localStorage or another cross-session cache.

## 7. Cache and revalidation

First load without data shows loading and issues one local request. Concurrent consumers and StrictMode effect replay share the in-flight request. Later navigation uses the persistent dashboard provider snapshot immediately and does not issue a config request per page.

Explicit refresh and focus after 60 seconds revalidate in the background. This threshold controls opportunistic freshness; it is not a TTL wrapper around the former slow endpoint. Cached data stays visible during refresh. Ordinary network failures preserve the current account's last loaded data and show a non-destructive error/retry notice. Initial failure, confirmed no configuration, and loading are distinct states.

Mutation invalidation waits for any pre-mutation in-flight GET to finish and then performs a new read. An old pending response cannot count as the final post-mutation refresh. Concurrent refresh calls are deduplicated.

## 8. Invalidation matrix

| Mutation/operation                                   | Invalidates?                                                        | Revalidates?                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| Initial connect/setup POST                           | Yes, after success                                                  | Yes, local GET                                        |
| Save credentials/configuration/display name          | Yes, after success                                                  | Yes                                                   |
| Token rotation/reconnect through existing save       | Yes, after success                                                  | Yes                                                   |
| Registration/PIN completion through save             | Yes, after successful persistence, including partial setup outcomes | Yes                                                   |
| WABA subscription/repair through save                | Yes, after successful save                                          | Yes                                                   |
| Delete/disconnect connection                         | Yes, after success                                                  | Yes; includes server-selected replacement primary     |
| Make primary                                         | Yes, after success                                                  | Yes                                                   |
| Inbound media retention PATCH                        | Yes, after success                                                  | Yes                                                   |
| Failed mutation                                      | No                                                                  | No mutation-success refresh                           |
| Switch selected connection in a form/editor          | No database mutation                                                | Uses shared collection                                |
| Test API connection                                  | No persisted mutation                                               | Live diagnostic only                                  |
| Verify registration                                  | No persisted mutation                                               | Live diagnostic plus local shared refresh             |
| Webhook legacy verification-token encryption upgrade | No client-visible configuration change                              | Not required; token presence is unchanged             |
| Account switch                                       | Clears/masks old account state                                      | Loads the new account                                 |
| Embedded Signup/coexistence completion               | No implementation exists here                                       | Future completion must use the same invalidation hook |

## 9. Removed direct fetches

Removed independent normal config requests from every caller in section 2. WhatsApp Settings hydrates and selects connections from shared data; successful writes explicitly revalidate through the provider. Flow data, template queries, conversations, and other feature-specific requests remain owned by their existing components.

## 10. Remaining direct config fetches

Only the provider performs normal config GET. Settings retains direct POST/PATCH/DELETE requests because these are configuration mutations. Its two explicit diagnostic actions call `/config/verify-registration`. No normal product page independently fetches normal config.

The existing capability endpoint remains as a tested local-only API contract, but the dashboard no longer requests it. Capability is derived from the shared connection collection, using the same persisted status/phone-identity criteria. Keeping the endpoint does not introduce a second client cache or navigation request.

## 11. Remaining live Meta calls

- `verifyPhoneNumber()` in config POST: verifies supplied credentials before saving. Required for connection/setup/update validation.
- `verifyPhoneNumber()` in verify-registration GET: explicit user-requested credential/phone diagnostic.
- `getSubscribedApps()` in verify-registration GET: explicit user-requested subscription diagnostic.
- Helper declarations in `meta-api.ts` remain unchanged.

Setup POST also retains existing WABA phone ownership lookup, phone registration, and WABA subscription operations. These remain appropriate setup operations. Repository search confirms no phone/subscription verification is reachable from normal config GET or shared-state navigation loading.

## 12. Host experience

Before: screens repeatedly waited for local reads plus live Meta checks, often after a separate capability request. Failures could look like disconnected configuration.

After: the dashboard loads local state once. Navigation reuses it; only feature-specific data may need loading. Refresh does not hide a usable page. Settings displays Configured and explicitly says live status has not been checked. Recorded registration history is labelled as such. Hosts can request live diagnostics when needed. Initial failure offers Retry rather than pretending no connection exists.

## 13. Security

Authentication and server-derived active-account filtering remain. Explicit connection selection cannot escape account ownership. Server responses use an allowlist rather than returning raw database rows. No access token, webhook verification token, app secret, or service credential enters the shared client snapshot. Background errors use a safe UI message. Configuration state is in-memory and isolated by account/user.

## 14. Tests and checks

Commands executed with the bundled Node runtime:

```sh
NODE=/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
$NODE node_modules/vitest/vitest.mjs run src/lib/whatsapp src/app/api/whatsapp src/hooks/use-whatsapp-capability.test.tsx src/hooks/use-automation-whatsapp-connections.test.tsx src/components/inbox/template-picker.test.tsx src/components/settings/whatsapp-config.test.tsx
$NODE node_modules/vitest/vitest.mjs run
$NODE node_modules/typescript/bin/tsc --noEmit
```

Scoped ESLint and Prettier checks cover every changed/new TypeScript file. `git diff --check` checks whitespace.

Relevant final suite: **52 files passed, 627 tests passed**. This includes actual Settings mutation interactions, explicit verification, shared-state isolation/races, setup behavior, picker behavior, low-level Meta, manual/broadcast semantic sends, webhook tests, and multi-connection behavior.

Full suite: **170 files passed, 1 failed, 4 skipped; 1,907 tests passed, 6 failed, 36 skipped**. The failing file is the unchanged locale parity suite described below.

Typecheck: **passed**. Scoped lint: **passed**. Formatting and whitespace: **passed**.

Six full-suite failures are pre-existing locale parity failures in `src/i18n/messages.test.ts` for Korean, Portuguese, and Spanish: missing template/Flow keys and invalid ICU body placeholder translations. `git diff --exit-code HEAD -- src/i18n` confirms that directory is unchanged. They were left outside this task. Opt-in live/Postgres tests remain skipped; no live Meta send or database mutation was performed during verification.

## 15. Performance verification

Verified by execution tests:

- Normal config GET calls neither Meta verification helper and never decrypts a token.
- Multiple mounted consumers share one request.
- Simulated navigation reuses loaded state without another request or loading transition.
- Background failure preserves usable account-owned cached state.
- Account switches and mismatched responses do not expose another account's data.
- Mutation invalidation fetches fresh data even when an older request was pending.

Not measured: authenticated browser/network timings against the running deployment, production database latency, or live Meta latency. No arbitrary millisecond assertion was introduced.

## 16. Risks and follow-ups

- Full-suite locale failures remain and should be fixed separately before a completely green release gate.
- Other teammates/tabs changing configuration are picked up by focus revalidation or explicit refresh; this task does not add a new realtime configuration subscription.
- Future Embedded Signup/coexistence completion must invalidate this shared state after saving a connection.
- Any non-repository consumer relying on the old config GET's live-health fields must move to the explicit verification endpoint. All repository callers were migrated.
- Live checks remain explicit and inherently network-dependent. They do not prove end-to-end WhatsApp message delivery.
