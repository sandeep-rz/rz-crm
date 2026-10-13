# WACRM upstream review — 61 commits against RZ CRM

Review snapshot from 13 October 2026. The initial audit made no code changes; the authorized implementation and its validation are recorded below.

## Verdict

**Selectively port the applicable fixes. Do not merge or cherry-pick all 61 commits.** The most useful missing changes are private page caching, complete broadcast pagination/exclusions, scoped storage metadata access, nested automation wait ordering, and dependency security/runtime guardrails. Many earlier security/auth fixes already exist under RZ commit IDs. OpenAI-compatible AI and interactive wait-for-reply are optional features.

## Exact scope and evidence

- RZ local `main` and GitHub comparison base: `a5aed6aba43d1cb07c599a5881b5c503bc94ef8e`.
- Upstream `main`: `27c6bdf43633d1746410168431a8b0e22b4f2ba6`; independently verified through the GitHub API. Local cached upstream objects match that exact head, so their patches are valid for this snapshot.
- Merge base: `aee1b01f4b557870f1bbf9e7f566a2759e8f20f3`.
- GitHub comparison: **61 upstream-only commits / 70 RZ-only commits**, diverged. Of the 61, **31 are non-merge commits and 30 are merges**. The upstream aggregate changes 159 files; this is not 61 independent bug fixes.
- Initial working tree was clean. `git fetch` could not write `.git/FETCH_HEAD` under the filesystem policy; live GitHub head verification established freshness without changing refs. No integration was attempted.
- Actual repository is a standalone npm Next.js CRM (`npm@10.9.9`, Next 16.3.5), not the four-app pnpm monorepo described in the supplied general instructions. Review follows the files actually present.
- Reviewed commit patches, merge parents/combined conflict resolutions, final upstream implementations, current overlapping RZ code, manifests/lockfiles and migrations. Findings below distinguish source evidence from untested deployment behavior.

[Requested comparison](https://github.com/sandeep-rz/rz-crm/compare/main...ArnasDon%3Awacrm%3Amain) · [Pinned upstream snapshot](https://github.com/ArnasDon/wacrm/tree/27c6bdf43633d1746410168431a8b0e22b4f2ba6) · [Pinned RZ snapshot](https://github.com/sandeep-rz/rz-crm/tree/a5aed6aba43d1cb07c599a5881b5c503bc94ef8e)

## Major fixes and whether RZ needs them

### 1. Shared page caching — high priority, missing

Upstream [cf945bf](https://github.com/ArnasDon/wacrm/commit/cf945bf) changes page responses to `private, no-store`, leaving API `no-store` and Next asset caching intact. It addresses shared-CDN caching of visitor-specific HTML or middleware login redirects, and stale HTML referencing deleted deployment chunks. Commit cites GHSA-8wxh-rv3x-hxvm.

**Current RZ evidence:** `next.config.ts`, page header rule, still explicitly emits `public, max-age=0, s-maxage=300, stale-while-revalidate=86400`. Its comment assumes auth/Next always prevent sharing; that assumption should not be the security boundary.

**Recommendation:** port the focused header change and regression coverage. Preserve RZ Facebook SDK CSP sources, microphone allowance, dev origins, standalone output and other headers. Confirm actual production HTML/redirect headers and clear previously cached pages when deploying. No live CDN leak was reproduced in this audit.

### 2. Broadcast pagination and exclusions — high priority, missing

Upstream [bea6377](https://github.com/ArnasDon/wacrm/commit/bea6377) addresses queries stopping at PostgREST's row cap. It adds ordered page reads and URL-safe chunks for all/tag/custom-field audiences, exclusions, custom values, CSV existing-contact lookup and send-recipient reads. Wizard estimates use a shared resolver. Resume uses exact backlog counts and a bounded deterministic slice.

**Current RZ evidence:** `src/hooks/use-broadcast-sending.ts` has unpaged contacts, contact-tags, custom-value and recipient reads; `.in()` batching in one helper does not page returned rows. `step2-select-audience.tsx` and `step4-schedule-send.tsx` also have independent count logic. `src/lib/whatsapp/broadcast-resume.ts` calculates remaining from the loaded rows instead of the full eligible count.

**Concrete impact:** a large audience may omit recipients, or a capped exclusion lookup may leave contacts eligible even though their tag should exclude them. Resume can report zero remaining while more eligible rows exist. Exact threshold depends on deployed PostgREST settings; the live setting was not queried.

**Recommendation:** adapt pagination into existing RZ paths and share resolution/count logic. Retain explicit active `account_id` filtering and ownership checks for tags/custom fields: upstream's new generic audience helper relies on RLS and does not include our explicit workspace guards. Keep semantic variable preparation, connection selection, atomic recipient claiming, `whatsapp_message_id` filters and `BROADCAST_DELIVERY_UNCONFIRMED` resend blocks. Exclusion-query failures should stop sending, not silently treat the exclusion set as empty. Validate >1,000 matches/exclusions, many custom values per contact, CSV chunks, wizard/send agreement and resume counts.

### 3. Storage-object SELECT policies — high priority, missing; requires adaptation

Upstream [1bf0cf8](https://github.com/ArnasDon/wacrm/commit/1bf0cf8) drops broad read policies for avatars, flow-media and chat-media, then scopes authenticated SELECT to the user folder or account folder.

**Current RZ evidence:** migrations `008_profile_avatars_storage.sql`, `016_flow_media_storage.sql` and `023_chat_media.sql` still define broad bucket SELECT policies. No later replacement matching upstream's scoped read policies was found. RZ has multi-account memberships in migration 043; upstream predicates only consult `profiles.account_id`.

**Recommendation:** add an RZ-specific forward migration for metadata/list/download API authorization, using the existing membership authorization model and path conventions. Check avatar replacement/upsert and teammate media access. Do not blindly use upstream's profile-only predicate; it would restrict access to the active profile account rather than all legitimate memberships.

**Scope limit:** this upstream migration does not make files private. These buckets remain public, and existing Meta sends use public media URLs. Supabase documents that public-bucket serving bypasses read access controls for anyone holding the URL. Closing public URL access would be a separate design change and would need a compatible Meta-fetch mechanism. [Supabase bucket access model](https://supabase.com/docs/guides/storage/buckets/fundamentals)

### 4. Nested waits in automation branches — important correctness fix, missing

Upstream [270a7de](https://github.com/ArnasDon/wacrm/commit/270a7de) combines two changes:

1. **Existing time-wait correctness:** propagate a suspended outcome out of enclosing condition branches; after continuation resumes, climb back through parent conditions and continue the outer scope in order.
2. **Optional feature:** `wait_for_reply` on interactive button/list sends, parked on the existing pending-execution table until the next inbound reply or a 24-hour deadline. Flows have precedence; a consumed reply suppresses content triggers and AI reply.

**Current RZ evidence:** `executeStepsFrom()` in `src/lib/automations/engine.ts` returns `Promise<void>`. A nested `wait` returns from its branch, but the parent condition call then continues its own loop. `resumePendingExecution()` resumes only the saved scope and has no parent-scope climb. Thus the outer step can execute before the branch's delayed work. This is a static control-flow finding; a dedicated runtime reproduction was not run.

**Recommendation:** port the suspension/parent-resume correction separately from the optional reply feature. Keep `completed_wait_continuation_ids`, `complete_automation_wait_continuation`, retry-safety acceptance markers, deactivation/account boundaries, PMS execution versions and current log/execution ownership. Test nested time waits, multiple nested conditions, second suspension after resume, replay attempts and failed/ambiguous sends.

**Reply feature caution:** upstream identifies parked runs by account/contact; RZ shares contacts across multiple WhatsApp connections. Match the intended connection and conversation, revalidate scope, and keep Coexistence history/echoes out of automation triggers. Superseding a wait and inserting a new one are separate upstream operations; review concurrency and reply-arrives-during-send behavior before treating this feature as production ready. Reuse existing engine/continuation infrastructure.

### 5. Internal SECURITY DEFINER function grants — already stronger in RZ

Upstream [fa4d1bf](https://github.com/ArnasDon/wacrm/commit/fa4d1bf) revokes execution of six internal functions from PUBLIC/anon/authenticated and grants execution to service_role.

**Current RZ evidence:** `supabase/migrations/79_whatsapp_runtime_hardening.sql` already revokes those six and grants only the four legitimate runtime helpers. The legacy `merge_duplicate_contacts()` and `merge_duplicate_conversations()` are disabled and denied to service_role as well.

**Recommendation:** skip this migration. Copying upstream grants would contradict the RZ boundary for legacy global deduplication. Database deployment status was not queried; ensure migration 79 is applied when separately verifying live environments.

[7ec52e9](https://github.com/ArnasDon/wacrm/commit/7ec52e9) adds useful CI policy/grant assertions. Adapt them: verify service_role can call the four runtime helpers and cannot call the two disabled dedupe functions. RZ's current schema verifier has worker-security checks but lacks this exact six-function/storage coverage. Grants and RLS are separate controls. [Supabase Data API security](https://supabase.com/docs/guides/api/securing-your-api)

### 6. Dependency security floors and Node compatibility — high priority maintenance

[ce0a505](https://github.com/ArnasDon/wacrm/commit/ce0a505) raises Next/eslint-config-next to 16.3.8 and dependency floors for MCP SDK, proxy-addr, undici, ip-address, fast-uri, sharp, brace-expansion and source-map-js. The commit says it clears open Dependabot alerts; this audit did not retrieve RZ's private alert list or independently establish exploitability for every package.

Current root lockfile evidence:

| Package | RZ locked | Upstream floor/change |
| --- | --- | --- |
| Next | 16.3.5 | 16.3.8 |
| MCP SDK | 1.30.0 | 1.31.0 |
| proxy-addr | 2.0.7 | 2.0.8 |
| undici | 7.29.0 | 7.29.1 |
| ip-address | 10.4.0 | 10.7.1 |
| fast-uri | 3.1.7 | 3.1.8 |
| sharp | 0.35.4 | 0.35.5 |
| source-map-js | 1.2.1 | 1.2.2 |

The separate MCP server still specifies SDK `^1.18.0`; update its manifest/lockfile too if it is deployed. Upstream separately raises both brace-expansion 1.x and 5.x floors; inspect nested lock entries during the dependency pass.

[a37c20f](https://github.com/ArnasDon/wacrm/commit/a37c20f) changes Supabase from `^2.107.0` to `~2.109.0`, preventing resolution onto the Node-22-only release line described by upstream. RZ targets Node >=20 and Docker uses `node:20-alpine`; RZ currently locks Supabase 2.108.2 but the broad manifest range allows future incompatible resolutions. [e8caae4](https://github.com/ArnasDon/wacrm/commit/e8caae4) adds matching Dependabot ignore rules for Supabase/SSR/Vitest.

**Recommendation:** update compatible security floors and runtime ranges as a focused maintenance change, regenerate root/MCP lockfiles and run build/typecheck/tests on the deployment Node version. Ordinary Base UI, Dagre, icon, toast, Tailwind Merge, next-intl, Prettier and Node-type bumps are optional; no individual RZ defect was established merely from their version changes. Avoid copying unrelated native-package lock churn.

### 7. Earlier security/auth fixes — already present

| Upstream | Current RZ equivalent | Verified behavior |
| --- | --- | --- |
| ce016af | 4b4d6a8 | Callback exchange/reset page and safe redirects |
| 1918be1 | 14d35e5 | Protect flows/agents/notifications when signed out |
| 2f5b815 | ad49144 | IPv4/IPv6 SSRF checks |
| 8d6225a | 9345476 | Conversation tenancy and template admin gates |
| 43c82b0 | 8ea9e10 | Preserve encrypted verify token on blank save |
| cfbde12 | 3e79785 | Saved-token Spanish/Portuguese hint |
| 2605356 | f8a1cc7 | Contact-import locale keys |

All seven local commits are ancestors of current HEAD. The automation-account issue in a3b2e57 is also already addressed by RZ's current per-ID and duplicate routes, although that exact upstream SHA is not an ancestor. Historical commit counts therefore overstate missing behavior.

### 8. Optional AI and localization work

- [76538fd](https://github.com/ArnasDon/wacrm/commit/76538fd) adds a third, OpenAI-compatible chat provider with configurable base URL, encrypted key reuse, credential testing and schema support. RZ currently supports OpenAI/Anthropic only. This is an optional feature, not a fix for those existing providers. If added, include [d634c03](https://github.com/ArnasDon/wacrm/commit/d634c03): require HTTPS for public hosts, permit private HTTP only through a server-controlled exact-host allowlist, reject embedded credentials/query fragments, block arbitrary private addresses and use manual redirects. Preserve webhook SSRF defaults.
- [fbabe3f](https://github.com/ArnasDon/wacrm/commit/fbabe3f) broadly localizes previously hardcoded UI/API/validator text, starter content and labels in en/pt/es/ko. It is useful for non-English operation but touches heavily customized RZ files. Translate current RZ code instead of replacing upstream versions; preserve semantic variables and structured failure codes. [106fe5d](https://github.com/ArnasDon/wacrm/commit/106fe5d) translates errors for the new optional features.
- [7287c2a](https://github.com/ArnasDon/wacrm/commit/7287c2a) fixes all four catalogues entering the new `getT` client bundle by selecting a build-time catalogue alias. RZ has not introduced that helper, so this exact new bundling problem is not established here. Include the alias/TS/Vitest alignment if adopting the helper.

**Migration conflict:** upstream's final 043/044/045/046 filenames collide with RZ's existing multi-account, workspace, permission and multi-connection migrations. RZ history already runs through 80. Any adopted schema changes need new forward migrations through the project's existing process; preserve every historical RZ migration.

## Verification performed and limits

Ran the existing targeted Vitest suite for SSRF, verify token, auth callback route/helper, middleware, template lifecycle authorization, per-ID automation routes, automation engine and locale catalogues: **9 files, 137 tests: 131 passed / 6 failed; 8 files passed / 1 failed**.

The six failures are current locale catalogue problems, present without changes:

- ko/pt/es each lack `Flows.builder.form.bodyTextPlaceholder`, `Settings.templates.cardPreview`, `Settings.templates.needsVariableMapping`, and `Settings.templates.variablesConfigured`.
- ko/pt/es each contain invalid ICU syntax in `Settings.templates.bodyPlaceholder`, using unescaped WhatsApp `{{1}}`/`{{2}}` text.

These RZ-specific failures need a small catalogue repair regardless of whether broad upstream localization is adopted. The original 2605356 contact-import fix is already present and does not solve these newer gaps.

No full suite, build, typecheck, upstream-only test suite, live database grants/policies, CDN behavior, real Meta sends or production end-to-end tests were run. Passing existing automation tests does not disprove the uncovered nested-wait control flow. This is an applicability review, not a production readiness certificate.

## Safe implementation order after this report

1. Focused private-cache fix.
2. Focused broadcast pagination/exclusions/count correction, retaining account and delivery guards.
3. Compatible dependency security floors and Node runtime constraints.
4. Storage SELECT hardening with membership-aware policies and media-access validation; adapt CI grant/storage assertions.
5. Isolated nested-wait correction with RZ replay/PMS regression coverage.
6. Small RZ locale parity/ICU repair. Choose optional reply-wait, compatible-provider and broad localization work separately.

Before each implementation, inspect current overlapping code and give a narrow file/edit plan. Preserve RZ PMS projections/reconciliation, one automation engine and existing queues, reservation-version gates, continuation replay markers, active workspace authorization, multi-WhatsApp selection, semantic variable contracts, delivery-unknown resend blocks, Embedded Signup/Coexistence intake and branding. Review patches subsystem by subsystem; never replace our engine/webhook/config with upstream copies or blanket-resolve conflicts. Use an isolated integration branch for actual implementation and verify preservation against this pinned RZ baseline.

## Implementation history on develop — 13 October 2026

The user approved the focused fixes. Six implementation commits were created directly on `develop`, followed by a validation/documentation commit. All seven were subsequently undone with a mixed reset at the user's request; their file contents were preserved. The mappings below describe that implementation history, not commits currently on the branch. No upstream merge, production deployment, hosted migration or push was performed.

| RZ commit | Change | Upstream origin |
| --- | --- | --- |
| f88a849 | Private page cache policy; preserve RZ CSP and signup SDK configuration | cf945bf |
| 61f38e1 | Complete broadcast pagination, workspace-scoped shared audience/count helpers, fail-closed exclusions and exact resume backlog | bea6377 |
| 0cb118b | Security dependency floors in root/MCP, Node 20.19 minimum, Supabase 2.109.x/SSR 0.12.0/Vitest 4.x constraints and Dependabot guardrails | ce0a505, e8caae4, runtime portion of a37c20f |
| 101e5f3 | New migration 81 for membership-aware Storage SELECT; CI assertions preserve service-role denial of legacy dedupe | 1bf0cf8, adapted 7ec52e9 |
| b0f9f45 | Nested time waits suspend enclosing conditions and resume parent scopes in order; completion/acceptance evidence covers the entire resumed segment | Time-wait correctness portion of 270a7de |
| ad94ca8 | Repair four missing RZ locale keys and quote literal insertion hints safely in ICU | RZ-specific catalogue failures found during the audit |

Optional interactive reply waiting, OpenAI-compatible AI, broad localization and ordinary UI/development package upgrades remain excluded. Already equivalent auth/security fixes and upstream dedupe grants were not reapplied. The final audience callback dependency matches the complete shared audience input, with its obsolete lint suppression removed.

### Final validation

- **Node 20.20.2 full suite:** 192 files passed / 6 skipped; **2,298 tests passed / 114 skipped**. The skipped database-dependent tests were not reported as passing.
- **Nested waits:** all six new regressions fail against the original engine and pass with the fix. Existing continuation replay, delivery safety and PMS checks remain in the full suite.
- **Typecheck, changed-file ESLint, production Next build and separate MCP TypeScript build:** passed. Dependencies were installed from the regenerated lockfiles. Full-repository lint was not run.
- **Local production HTTP checks with dummy credentials:** `/login` 200 and `/inbox` 307 both emit `Cache-Control: private, no-store`; `/api/account` 401 emits `no-store`. This verifies local output, not the hosted CDN configuration or cache purge.
- **Disposable PostgreSQL 14 test:** applied the actual migration to a minimal Storage/Auth/membership fixture. Verified anonymous/foreign denial, multiple memberships, teammate access, legacy owner folders, own-avatar insert/update and revoked-membership denial. Applied migration 79's existing grant boundary to fixture functions; new CI assertions pass and correctly reject broad public SELECT and regranted service-role dedupe in rolled-back negative tests. This was not a full clean Supabase migration replay; Docker was unavailable.
- **Preservation:** all 70 pre-existing RZ-only commits remain ancestors of `develop`; no tracked paths were deleted. Historical migrations are unchanged. Checked PMS, webhook, Embedded Signup, variable runtime, send policy, broadcast delivery and pending-worker modules are unchanged. Only the existing automation engine's time-wait control flow was adapted.
- `git diff --check` passed. Hosted database policies/grants, deployed Meta sends and production end-to-end behavior remain untested.

**Deployment follow-up:** apply [migration 81](../supabase/migrations/81_storage_scoped_select.sql) through the existing deployment process. It restricts object metadata/list access; bucket visibility and public URLs are preserved. Use Node >=20.19 and purge old shared page caches when deploying. The implementation is now unstaged and uncommitted on `develop`, which matches `origin/develop`; it has not been pushed.

## Follow-up regression review of the uncommitted changes

Reviewed the complete current diff and new files, including runtime logic, tests, lockfile version/engine changes, public API consumers, media path callers, migration predicates and schema assertions. No remaining regression was found in the verified paths after the correction below.

**Correction found and fixed:** a resume query capped at the first 1,000 recipient rows could falsely report nothing to resume when that page contained invalid phones, or underfill a pass on a server capped below 1,000 rows. Resume now scans ordered pages until it has up to 1,000 sendable recipients or exhausts the audience. Invalid-row updates occur after scanning so they cannot shift offset pages; chunked updates, account/connection selection, accepted-message and delivery-unknown filters remain intact. Three regression cases (pending/failed invalid first pages and a 250-row server cap) failed before this correction and now pass. Unrelated Unicode escaping in the package descriptions was removed without changing the JSON values.

**Current results on Node 20.20.2:** full suite **2,291 passed / 114 skipped**, 191 files passed / 6 skipped. Typecheck, changed-file ESLint, production Next build and MCP build pass. The earlier cache test file is absent from the current working tree and was not restored; final built HTTP responses were directly checked instead: login 200 and inbox 307 both have `private, no-store`, account API 401 has `no-store`. MCP startup, initialize and tools/list also pass with the upgraded SDK and dummy configuration, with seven read-only tools and no API calls.

**Storage compatibility rechecked:** migration 81 passes on disposable PostgreSQL using RZ's actual `is_account_member` helper and membership SELECT policy, covering multiple workspaces, teammate reads, revoked membership, legacy owner folders and avatar insert/update. Avatar and chat/flow uploads continue using the existing paths and public URLs; the migration does not change bucket visibility or media upload/delete policies. Production database application and a full clean Supabase migration replay remain untested.

**Required deployment conditions:** use Node >=20.19 (Docker and CI already use the Node 20 line), deploy both manifests with their lockfiles, and apply migration 81 through the normal migration process. This is not a guarantee about untested hosted CDN/database/Meta behavior. All changes remain unstaged and uncommitted; original RZ history, historical migrations, PMS/signup/webhook/worker/delivery paths are preserved.

## Every upstream-only commit

Rows are in Git's reverse commit traversal order. Merge rows are reviewed for parent history and combined resolutions, then linked to the underlying change; they are not counted as independent fixes. “Optional maintenance” means no specific RZ application defect was established, not a claim that the package update has no benefit.

| # | Commit | Subject | Verdict | Applicability / preservation decision |
| --- | --- | --- | --- | --- |
| 1 | [ee6593f](https://github.com/ArnasDon/wacrm/commit/ee6593f03eb687d2578c7a220b608d22c32be845) | test(whatsapp): red — saving config without verify_token must keep the stored one | Covered / skip | Regression-test precursor; its helper intentionally preserves the old broken behavior. RZ already has the tests and fixed helper; do not cherry-pick the red skeleton. |
| 2 | [43c82b0](https://github.com/ArnasDon/wacrm/commit/43c82b07440b64f37cbd8a0d4c8a479d840de23c) | fix(whatsapp): keep stored verify_token when config is saved without one | Already fixed | Empty verify-token saves preserve encrypted stored token. Local 8ea9e10; current helper and config-save usage verified. |
| 3 | [a3b2e57](https://github.com/ArnasDon/wacrm/commit/a3b2e57a23bd462f7bf2a08f82474b3bf833e4f0) | fix(security): scope per-automation routes by account, not author (GHSA-xvrq-88hg-44q6) | Already equivalent | Removed automation authors must lose access after account removal. Current GET/PATCH/DELETE/duplicate authorize by account, with agent gates on writes; preserve richer RZ activation and PMS logic. |
| 4 | [2f5b815](https://github.com/ArnasDon/wacrm/commit/2f5b8156b9e89b18f91ab069a4ede208fd727ef8) | fix(security): classify IPs from octets in the SSRF guard (GHSA-m4cp-pqxq-x9f7, GHSA-q4p6-pj4g-26xx) | Already fixed | Octet-based IPv4/IPv6 SSRF classification, including transition encodings. Local ad49144; current implementation and tests verified. |
| 5 | [8d6225a](https://github.com/ArnasDon/wacrm/commit/8d6225a07b32e4b53e87343472d7db615ce4a3a2) | fix(security): scope conversations by account and gate template lifecycle on admin (GHSA-m4fx-g6pr-hrw8) | Already fixed | Conversation account scope and admin-only template lifecycle. Local 9345476; retain current connection-aware and semantic template behavior. |
| 6 | [ce016af](https://github.com/ArnasDon/wacrm/commit/ce016af04eec45ec6de4025895cf54b7fcf15b2a) | fix(auth): add /auth/callback and /reset-password, route emailed links through the app's origin | Already fixed | Auth callback, password reset, same-origin redirect handling and email guidance. Local 4b4d6a8; regression tests pass. |
| 7 | [2605356](https://github.com/ArnasDon/wacrm/commit/2605356b8427a56a90d1efe70663020b45d84757) | fix(i18n): add the missing Contacts.importModal keys to pt and es | Already fixed | Six missing contact-import keys in Spanish/Portuguese. Local f8a1cc7 is an ancestor of HEAD; current keys exist. |
| 8 | [cf3733e](https://github.com/ArnasDon/wacrm/commit/cf3733e197beadf56596019e7f80d74e98514a91) | chore(deps-dev): bump the dev-dependencies group across 1 directory with 2 updates | Optional maintenance | Prettier 3.9.9 and Node type 26.6.2 lockfile refresh, plus transitive lock changes. No new application fix demonstrated. |
| 9 | [d5d9231](https://github.com/ArnasDon/wacrm/commit/d5d9231129bca0f27a76f6fc9a1722fca78e2024) | Merge remote-tracking branch 'origin/main' into fix/592-auth-callback-reset-password | Merge / track underlying change | Auth branch synchronization; no combined resolution diff. Behavior tracked under ce016af. |
| 10 | [15c35c7](https://github.com/ArnasDon/wacrm/commit/15c35c793e069b5b89d5a5c21b3c6718e102c261) | Merge branch 'main' into fix/keep-stored-verify-token | Merge / track underlying change | Verify-token branch synchronization with config-route conflict resolution: combines token preservation and WABA/phone checks. RZ already retains these checks in its newer connection-aware setup. |
| 11 | [cfbde12](https://github.com/ArnasDon/wacrm/commit/cfbde128dee5aa3de5d015a30ecf31b9e991d793) | i18n: add webhookVerifyTokenSaved to pt and es | Already fixed | Saved verify-token hint in Spanish/Portuguese. Local 3e79785; keep RZ catalogue additions. |
| 12 | [1918be1](https://github.com/ArnasDon/wacrm/commit/1918be1446c85c531aab9752af8134d4cbb886d2) | fix(auth): redirect signed-out visitors away from /flows, /agents and /notifications | Already fixed | Signed-out redirects for flows/agents/notifications. Local 14d35e5; dashboard protection test passes. |
| 13 | [5d1619b](https://github.com/ArnasDon/wacrm/commit/5d1619b8f758717c4472bfaca3e47ae66148c852) | Merge pull request #587 from ArnasDon/fix/ghsa-xvrq-88hg-44q6-automation-account-scope | Merge / track underlying change | Merges automation account-scope fix a3b2e57; no separate fix. |
| 14 | [4881110](https://github.com/ArnasDon/wacrm/commit/4881110cb161d49755c7756871471739c162a9d6) | Merge pull request #588 from ArnasDon/fix/ghsa-m4cp-q4p6-ssrf-ipv6 | Merge / track underlying change | Merges SSRF fix 2f5b815; no separate fix. |
| 15 | [c87a3e7](https://github.com/ArnasDon/wacrm/commit/c87a3e7eed861b7f51d60ae4495eb140f0e716e0) | Merge pull request #589 from ArnasDon/fix/ghsa-m4fx-g6pr-hrw8-authz | Merge / track underlying change | Merges conversation/template authorization 8d6225a; no separate fix. |
| 16 | [13ab684](https://github.com/ArnasDon/wacrm/commit/13ab6849f116c198dd1498f2abf7c7d47b29aad7) | Merge pull request #597 from ArnasDon/fix/592-auth-callback-reset-password | Merge / track underlying change | Merges callback/reset ce016af; no separate fix. |
| 17 | [1c27d71](https://github.com/ArnasDon/wacrm/commit/1c27d71c0678c8d56a8d1d36fcf58ca646c096ba) | Merge pull request #607 from ArnasDon/fix/middleware-protect-flows-agents-notifications | Merge / track underlying change | Merges protected dashboard routes 1918be1; no separate fix. |
| 18 | [cd3b64f](https://github.com/ArnasDon/wacrm/commit/cd3b64f794fdd80827d47b64c85333d63fdf2407) | Merge pull request #598 from ArnasDon/dependabot/npm_and_yarn/dev-dependencies-6b9ae8d98f | Merge / track underlying change | Merges development dependency refresh cf3733e; no separate fix. |
| 19 | [2951660](https://github.com/ArnasDon/wacrm/commit/2951660f31f29fc2fb96732b95259623b29fab07) | chore(deps): bump next-intl from 4.13.5 to 4.14.7 | Optional maintenance | next-intl 4.13.5 to 4.14.7. Consolidate with 086052d if updating; no independent RZ defect established. |
| 20 | [75b4df3](https://github.com/ArnasDon/wacrm/commit/75b4df37a853bc9ccf78538db14db8b3fd6e6869) | chore(deps): bump @base-ui/react from 1.6.0 to 1.8.0 | Optional maintenance | Base UI 1.6.0 to 1.8.0. Verify customized dialogs, sheets, menus and selectors before adopting. |
| 21 | [16ff9ee](https://github.com/ArnasDon/wacrm/commit/16ff9eec2842107805e2765e7c3ffdac2814677c) | Merge pull request #554 from Guru35/fix/keep-stored-verify-token | Merge / track underlying change | Merges verify-token test/fix and translations; already covered by RZ ports. |
| 22 | [53ac047](https://github.com/ArnasDon/wacrm/commit/53ac0476d0e1ce2e9ac00ddb80c9b7ff14ee5e35) | Merge pull request #583 from ArnasDon/dependabot/npm_and_yarn/next-intl-4.14.3 | Merge / track underlying change | Merges next-intl bump 2951660; no separate fix. |
| 23 | [f56534e](https://github.com/ArnasDon/wacrm/commit/f56534eb358e61b06846a8a45d632c51966b2a28) | Merge pull request #582 from ArnasDon/dependabot/npm_and_yarn/base-ui/react-1.8.0 | Merge / track underlying change | Merges Base UI bump 75b4df3; no separate fix. |
| 24 | [c801cf2](https://github.com/ArnasDon/wacrm/commit/c801cf2733e46461dec12cc7fbab8954172bdc40) | chore(deps): bump @dagrejs/dagre from 3.1.0 to 3.1.1 | Optional maintenance | Dagre 3.1.0 to 3.1.1. Graph-layout dependency update; no specific RZ bug demonstrated. |
| 25 | [45e80ad](https://github.com/ArnasDon/wacrm/commit/45e80ad9e23b91f5c02ab9f935edbae67810e59d) | Merge pull request #509 from ArnasDon/dependabot/npm_and_yarn/dagrejs/dagre-3.1.1 | Merge / track underlying change | Merges Dagre bump c801cf2; no separate fix. |
| 26 | [76538fd](https://github.com/ArnasDon/wacrm/commit/76538fdf5c21bcbbf7473f4bb33349d07d2c0dc3) | Add secure OpenAI-compatible AI provider | Optional feature | OpenAI-compatible provider, base URL, validation/UI and schema. Include d634c03 if desired; keep default webhook SSRF restrictions unchanged. |
| 27 | [529300b](https://github.com/ArnasDon/wacrm/commit/529300be87938b5ae98fc60a0d6381004464beb3) | chore(deps-dev): bump @types/node | Optional maintenance | Node type lockfile 26.6.2 to 26.6.4; also removes optional native-package libc metadata. Avoid adopting unrelated lock churn blindly. |
| 28 | [086052d](https://github.com/ArnasDon/wacrm/commit/086052dcc38027097caae142085e87bcc7747f5b) | chore(deps): bump next-intl from 4.14.7 to 4.14.8 | Optional maintenance | next-intl 4.14.7 to 4.14.8. One consolidated update is sufficient. |
| 29 | [151a88c](https://github.com/ArnasDon/wacrm/commit/151a88c3704bd6e7799a499f6f96b24b6cffa049) | chore(deps): bump lucide-react from 1.30.0 to 1.49.0 | Optional maintenance | Lucide 1.30.0 to 1.49.0; superseded upstream by a37c20f. Check RZ icon compatibility. |
| 30 | [270a7de](https://github.com/ArnasDon/wacrm/commit/270a7de643b0c7a99a383e92682ab37cf6fc9926) | automation_wait_for_reply | Split / selectively port | Real nested-wait suspension/resume fix should be adapted. Interactive wait-for-reply is optional; upstream account/contact-only reply matching needs RZ connection/conversation scoping. |
| 31 | [fbabe3f](https://github.com/ArnasDon/wacrm/commit/fbabe3ff34d08910a8869d3ce7830799037e4666) | i18n: translate remaining hardcoded UI, validator and API strings | Optional / adapt | Broad localization across UI, APIs, validators and starter content. Keep RZ branding, semantic rules and catalogue keys. Does not automatically resolve current RZ-specific locale failures. |
| 32 | [816e03f](https://github.com/ArnasDon/wacrm/commit/816e03ffc2cd48885c6294262a77fc1619709d89) | Merge pull request #622 from ArnasDon/dependabot/npm_and_yarn/next-intl-4.14.8 | Merge / track underlying change | Merges next-intl bump 086052d; no separate fix. |
| 33 | [2be7fb0](https://github.com/ArnasDon/wacrm/commit/2be7fb0e71f7332799b94d63d40c8448a2a1f412) | Merge pull request #623 from ArnasDon/dependabot/npm_and_yarn/lucide-react-1.49.0 | Merge / track underlying change | Merges Lucide bump 151a88c; manifest/lock conflict resolution retains next-intl 4.14.8. Treat as consolidated maintenance. |
| 34 | [cf945bf](https://github.com/ArnasDon/wacrm/commit/cf945bf6983eee1e2a4ecd129aecd39a4f8a5bb0) | fix(security): keep page responses out of shared caches | High / port | Replace public shared-cache page policy with private, no-store. Current RZ config still contains public s-maxage=300 and stale-while-revalidate=86400. |
| 35 | [e667851](https://github.com/ArnasDon/wacrm/commit/e66785198bb7d26911cdd403f1c90e81cb05ef13) | Merge pull request #620 from ArnasDon/dependabot/npm_and_yarn/dev-dependencies-155033dc32 | Merge / track underlying change | Merges Node types refresh 529300b; no separate fix. |
| 36 | [7ec52e9](https://github.com/ArnasDon/wacrm/commit/7ec52e9914c71d1ac5ccc7f3f704a76b3ddf2038) | ci: assert storage SELECT policies and internal function grants are not exposed to anon | Recommended / adapt | CI assertions for scoped storage policies and internal function grants. RZ grant hardening exists, but these exact assertions do not; dedupe functions must remain denied even to service_role. |
| 37 | [e8caae4](https://github.com/ArnasDon/wacrm/commit/e8caae49d24b174f76a99883915295404dd89381) | chore(dependabot): skip Supabase and vitest releases that require Node 22 | Recommended maintenance | Dependabot Node-20 guardrails for Supabase and Vitest. Coordinate with a37c20f; ignore settings alone do not constrain npm resolution. |
| 38 | [ce0a505](https://github.com/ArnasDon/wacrm/commit/ce0a505b19b82cbc2539d9ac4ce8c3ac38cdd6df) | fix(deps): raise security floors to clear open Dependabot alerts | High / adapt | Security dependency floors, including Next 16.3.8 and MCP SDK. RZ pinned/locked versions are older; update selected manifests and regenerate both lockfiles, then validate. |
| 39 | [bea6377](https://github.com/ArnasDon/wacrm/commit/bea6377c09c9be1b175c4ad165c2f9a1bda422f4) | fix(broadcasts): page audience queries past PostgREST's 1000-row cap | High / port | Pagination/chunking for audience selection, exclusions, custom values, CSV lookup, send recipients and resume backlog. Preserve explicit active-account filters and delivery-unknown guards. |
| 40 | [1bf0cf8](https://github.com/ArnasDon/wacrm/commit/1bf0cf89cfe4f3cb6a62af10e6494805c5eee379) | fix(db): scope storage SELECT policies to the folder owner | High / adapt | Restrict storage-object SELECT/list access to folder owner or account. RZ still has broad SELECT policies; adapt to account_members. Public URLs remain public. |
| 41 | [fa4d1bf](https://github.com/ArnasDon/wacrm/commit/fa4d1bf2862aeae6ef8b20989522447ffdd17ee9) | fix(db): revoke anon/authenticated EXECUTE on internal SECURITY DEFINER functions | Already stronger / skip | RZ migration 79 revokes all six internal functions from public/anon/authenticated and disables legacy global dedupe functions even for service_role. Do not regrant them. |
| 42 | [fd846d1](https://github.com/ArnasDon/wacrm/commit/fd846d1820a04e011ef50494ef0626f15a921539) | Merge pull request #626 from ArnasDon/fix/no-shared-cache-for-pages | Merge / track underlying change | Merges cache fix cf945bf; implement the focused config fix, not the merge. |
| 43 | [cc6ee2f](https://github.com/ArnasDon/wacrm/commit/cc6ee2f79ca3fe5825455a6b2e16400eba78a586) | Merge pull request #629 from ArnasDon/fix/dependency-security-floors-2026-10 | Merge / track underlying change | Merges dependency floors ce0a505; adopt selected dependency changes. |
| 44 | [7d96bba](https://github.com/ArnasDon/wacrm/commit/7d96bbaf499653969ef205af82b48f023e868111) | Merge pull request #627 from ArnasDon/chore/dependabot-node20-ignores | Merge / track underlying change | Merges Dependabot Node guardrails e8caae4; no separate fix. |
| 45 | [7861614](https://github.com/ArnasDon/wacrm/commit/786161431613eb98ead9bbf814402a0c3c7b4c59) | Merge pull request #630 from ArnasDon/fix/608-broadcast-audience-pagination | Merge / track underlying change | Merges broadcast pagination bea6377; adapt original behavior to RZ. |
| 46 | [f548c8d](https://github.com/ArnasDon/wacrm/commit/f548c8dc85350261424740ed70217d90fab42ff5) | Merge remote-tracking branch 'origin/main' into contrib/automation-wait-for-reply | Merge / track underlying change | Wait-for-reply branch synchronization; no combined resolution diff. Review 270a7de final behavior. |
| 47 | [9371738](https://github.com/ArnasDon/wacrm/commit/9371738a71e4aa8ef9def7ea132bf72c8fb32383) | chore(migrations): renumber automation wait-for-reply migration to 045 | Skip numbering / adapt if feature | Upstream renumbers wait-for-reply migration to 045. RZ already uses 045 for workspace permissions; never copy this numbering. |
| 48 | [3f2db49](https://github.com/ArnasDon/wacrm/commit/3f2db49ca6e6db58ee2f989db0dc96703a5a31b7) | Merge pull request #628 from ArnasDon/fix/storage-and-definer-grants | Merge / track underlying change | Merges storage/function-grant hardening; split missing storage work from RZ grants already fixed. |
| 49 | [469ea57](https://github.com/ArnasDon/wacrm/commit/469ea576e525fde69f17787872eb75287b8e7e96) | Merge remote-tracking branch 'origin/main' into contrib/openai-compatible-provider | Merge / track underlying change | AI-provider branch synchronization; no combined resolution diff. |
| 50 | [d634c03](https://github.com/ArnasDon/wacrm/commit/d634c0330e1446e64dfae009877897cc28c2fc3c) | fix(ai): require https for OpenAI-compatible hosts outside the allow-list, renumber migration to 046 | Required with optional AI feature | Reject public HTTP credential-bearing AI endpoints; allow HTTP only for operator-approved hosts. Also renumbers to 046, already occupied by RZ. |
| 51 | [ced3f5f](https://github.com/ArnasDon/wacrm/commit/ced3f5f24a249aedb2fa8f820900c3fc955c4161) | Merge remote-tracking branch 'origin/main' into contrib/automation-wait-for-reply | Merge / track underlying change | Wait-for-reply branch synchronization; combined CI resolution adds both storage/grant and wait-schema assertions. Adapt to RZ schema and grant policy. |
| 52 | [95b8f36](https://github.com/ArnasDon/wacrm/commit/95b8f360217df84ad9e2c2b0432447776ae3970c) | Merge remote-tracking branch 'origin/main' into contrib/openai-compatible-provider | Merge / track underlying change | AI-provider branch synchronization; no combined resolution diff. |
| 53 | [5798e15](https://github.com/ArnasDon/wacrm/commit/5798e158874d7c9bb0255be3cfd0ad573304f864) | Merge pull request #636 from ArnasDon/contrib/automation-wait-for-reply | Merge / track underlying change | Merges wait-for-reply and nested wait changes plus migration renumbering; adapt, do not replace RZ engine/webhook. |
| 54 | [6397a0b](https://github.com/ArnasDon/wacrm/commit/6397a0bfa4e4ec217f86782dcae7ff7aac0594a8) | Merge remote-tracking branch 'origin/main' into contrib/openai-compatible-provider | Merge / track underlying change | AI-provider branch synchronization; no combined resolution diff. |
| 55 | [76c1f9d](https://github.com/ArnasDon/wacrm/commit/76c1f9d97d939fa4d37104e7e6f59d67f43a0358) | Merge pull request #609 from whoissajo/contrib/openai-compatible-provider | Merge / track underlying change | Merges compatible provider and HTTPS correction; optional feature, not a missing existing-provider fix. |
| 56 | [f039a66](https://github.com/ArnasDon/wacrm/commit/f039a6640ff9344636d85ce89e03fad0d18a722c) | Merge remote-tracking branch 'origin/main' into i18n-pt-completo | Merge / track underlying change | Localization branch synchronization; combined resolutions integrate AI routes, wait previews, broadcast pagination and four catalogues. Review these together with optional i18n changes; no extra independent security fix. |
| 57 | [7287c2a](https://github.com/ArnasDon/wacrm/commit/7287c2a50cab2ba279127ea41a20dcff7b68affc) | fix(i18n): bundle only the active locale's catalogue on the client | Conditional performance fix | Build alias prevents new getT helper from bundling every catalogue. RZ has not added that helper; adopt only with localization port, preserve Next config additions. |
| 58 | [106fe5d](https://github.com/ArnasDon/wacrm/commit/106fe5dae69f3d5eb223988b5e4091816e3cfdd5) | i18n: translate the strings added by the wait-for-reply and OpenAI-compatible changes | Conditional localization | Translate wait-for-reply and compatible-provider errors; relevant only if those changes are adopted. |
| 59 | [7133a0f](https://github.com/ArnasDon/wacrm/commit/7133a0f395ba40fffc0f405c8c71e0a9516f29e1) | Merge pull request #625 from Kaike-png/i18n-pt-completo | Merge / track underlying change | Merges localization, active-catalogue alias and feature translations; optional, preserve RZ text and rules. |
| 60 | [a37c20f](https://github.com/ArnasDon/wacrm/commit/a37c20f15eb6eb186bfd6051b1badbaa2b448d06) | chore(deps): bump supabase-js, lucide-react, sonner and tailwind-merge | Split / adopt runtime guard | Supabase ~2.109.0 avoids drifting onto Node-22-only releases under Node 20. Lucide, Sonner and Tailwind Merge bumps are optional UI maintenance. |
| 61 | [27c6bdf](https://github.com/ArnasDon/wacrm/commit/27c6bdf43633d1746410168431a8b0e22b4f2ba6) | Merge pull request #637 from ArnasDon/chore/deps-2026-10-07 | Merge / track underlying change | Merges combined dependency update a37c20f; separate runtime guard from cosmetic/library maintenance. |
