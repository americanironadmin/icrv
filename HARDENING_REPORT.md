# ICRV Production Hardening — Final Report

**Branch series:** `hardening/01-headers` → `hardening/07-polish`
**Audit closed:** ICRV-Production-Audit.md (2026-05-03)
**Executor:** Claude Code, autonomous run
**Date:** 2026-05-03

This report tracks closure of every Critical, High, and Medium audit finding,
plus the four Low findings the plan called out. It also collects every manual
step the human still has to execute (DNS, Cloudflare Access policies, Sentry
DSNs, secret config) so they can be done in one sitting.

---

## Status table

| ID | Sev | Area | PR | Closed by | Verify with |
|----|-----|------|----|-----------|-------------|
| C1 | Critical | Auth | PR 6 | `frontend/src/App.tsx` — SignIn textarea deleted, AccessSignIn panel only links to `/cdn-cgi/access/login/<AUD>` | `grep "Bearer JWT" frontend/src` returns nothing; browser flow forces Access login |
| C2 | Critical | Auth | PR 6 | `frontend/src/App.tsx` — `?token=` URL ingestion removed; `frontend/src/api/client.ts` — sessionStorage interceptor removed | Bundle has 0 occurrences of `icrv_token` |
| C3 | Critical | Auth | PR 2 (CSP) + PR 6 (cookie cutover) + `polish/csp-enforce-flip` | CSP **enforcing** on `_headers` (flipped 2026-05-04 after zero-violation Playwright walk) + Access cookie path only | `curl -sI <pages-hash>.icrv-dashboard.pages.dev/ \| grep -i "^content-security-policy:"` (custom domain returns 401 to anonymous curl since Access protects the bare host) |
| C4 | Critical | Headers | PR 1, PR 2 | `frontend/public/_headers` — HSTS, X-Frame-Options DENY, Permissions-Policy, COOP, X-Content-Type-Options, Referrer-Policy, CSP | `curl -sI <pages>/contacts \| grep -iE "strict-transport\|x-frame\|permissions-policy\|cross-origin-opener\|content-security-policy"` |
| C5 | Critical | API | PR 3 | `packages/shared/src/rate-limit.ts` + `workers/icrv-api/src/index.ts` — 10/60s on `/v1/auth/*`, 120/60s on `/v1/*` | 25× burst returns 401s then 429s |
| C6 | Critical | Auth | PR 3 + PR 6 | `KV_REVOKED` + `/v1/auth/logout` + `authMiddleware` JTI check | Logout → JTI persisted → next request 401 token_revoked |
| C7 | Critical | Hosting | PR 6 + cutover Phase E | Live on `https://icrv.americanironus.com` (Pages) and `https://icrv-api.americanironus.com` (Worker). `icrv-api` deployed at version `a053e4d3-3649-445c-9991-e06f60d3a4ae`; Pages deployment `36a4f502.icrv-dashboard.pages.dev` aliased to `main` branch / custom domain. CORS allowlist trimmed to `icrv.americanironus.com` + `pages.dev` (transitional) + `localhost:5173`. | `curl -sI https://icrv-api.americanironus.com/health` → `200`; `curl -sI https://icrv.americanironus.com/` → `302 → cloudflareaccess.com` |
| H1 | High | Perf | PR 1 | `_headers` — `/assets/*` → `max-age=31536000, immutable` | `curl -sI <pages>/assets/index-*.js \| grep cache-control` |
| H2 | High | Reliability | PR 5 | `frontend/src/components/RouteErrorBoundary.tsx`, wired into every Route in `App.tsx` | Throw an error from DevTools → see route boundary, not blank screen |
| H3 | High | Ops | PR 4 | `@sentry/cloudflare` on api/hooks/voice/agent + `@sentry/react` on Pages + `scrubPii` everywhere | After DSN set: trigger error → event lands in Sentry |
| H4 | High | Cost/Perf | PR 5 | `frontend/src/hooks/usePolling.ts` — `document.visibilitychange` listener | DevTools Network: switch tabs for 10s, no `/v1/*` calls during hidden interval |
| H5 | High | Hygiene | PR 1 | `_redirects` — explicit allowlist + `/* /index.html 404`; `robots.txt` + `noindex` meta | `curl -sI <pages>/anything-bogus` → `HTTP/2 404` |
| H6 | High | Input | PR 5 | Client (`Contacts.tsx`): 10 MB / 50k row caps via PapaParse step. Server (`contacts.ts`): Content-Length 413 + post-parse row cap | Drop 20 MB CSV → toast error, no `/bulk-upload` request fires |
| H7 | High | UX | PR 5 | `Contacts.tsx` BulkUploadModal — `MAX_POLL_MS = 5 min` deadline + cleanup | Manual: stall a job → modal closes after 5 min with "check Logs" toast |
| M1 | Medium | Auth | PR 6 | Removed Bearer interceptor; `authMiddleware` rejects browser-Origin Bearer with `400 browser_bearer_disallowed` | `curl -H "Origin: https://app.icrv.app" -H "Authorization: Bearer x" $API/v1/auth/me` → 400 |
| M2 | Medium | API | PR 3 | `index.ts` CORS unification — `Vary: Origin` always emitted; agent-controls clone matches | `curl -sI -H "Origin: https://app.icrv.app" $API/health \| grep -i vary` → `Vary: Origin` |
| M3 | Medium | Build | PR 5 | `frontend/vite.config.ts` — `esbuild.drop: ['console','debugger']` in prod | `grep -c "console\." frontend/dist/assets/index-*.js` → 0 |
| M4 | Medium | UX | PR 1 | `frontend/index.html` — `<noscript>` block | View source on production HTML |
| M5 | Medium | SEO | PR 1 | `<meta name="robots" content="noindex,nofollow,noarchive">` + real `robots.txt` | `curl -s <pages>/robots.txt` returns `User-agent: * / Disallow: /` |
| M6 | Medium | Authz | PR 3 | `requireAdmin` / `requireNotViewer` named middlewares + `requireNotViewer` on `/v1/agent-controls/*` + 3 vitest specs | `cd workers/icrv-api && npm test` → 3/3 pass |
| M7 | Medium | UX | PR 5 | `Header.tsx` — `friendlyServiceError()` mapping helper | Hover service status pill → friendly message, never raw stack |
| M8 | Medium | Ops | PR 5 | `Sidebar.tsx` reads `import.meta.env.VITE_BUILD_SHA`; `frontend/package.json` build script injects `git rev-parse --short HEAD` | Sidebar bottom shows `ICRV <sha> · CF Workers` |
| L1 | Low | Compat | PR 7 (deferred — see backlog) | Need a real `.ico` + `apple-touch-icon.png` (binary asset task) | n/a |
| L2 | Low | Perf | PR 7 | `frontend/index.html` Google Fonts URL trimmed to weights actually used in `index.css` | `curl -s "<fonts URL>" \| wc -c` smaller than baseline |
| L3 | Low | Headers | PR 1 | Pages `_headers` controls our HTML now; `Access-Control-Allow-Origin: *` no longer set on dashboard HTML | `curl -sI <pages>/ \| grep -i access-control` |
| L4 | Low | A11y | PR 7 (script ready, run after preview) | `scripts/audit-a11y.sh` + `npm run audit:a11y` (axe-core CLI) | `PREVIEW_URL=… npm run audit:a11y` after deploy |
| L5 | Low | UX | PR 7 | `ConfirmModal` + typed-confirm gates on KillSwitchModal (STOP), RejectModal (REJECT), ContactDetail delete (DELETE) | Click destructive button → modal requires typed word |

---

## Manual steps for the human

These are everything PR 1–7 cannot do automatically because they touch DNS,
Cloudflare-side configuration, real third-party accounts, or production
secrets. Group them into one focused session.

### 1. Cloudflare KV namespaces (PR 3 + PR 6)

```
wrangler kv namespace create KV_REVOKED
wrangler kv namespace create KV_JWKS
```

Copy the returned ids into `workers/icrv-api/wrangler.toml` — replace
`REPLACE_ME_KV_REVOKED_ID` and `REPLACE_ME_KV_JWKS_ID`.

### 2. Cloudflare Access (PR 6)

In Cloudflare dashboard → **Zero Trust → Access → Applications → Add**:

- Type: **Self-Hosted**
- Application domains:
  - `app.icrv.app`
  - `icrv-api.americanironadmin.workers.dev`
  - `api.icrv.app` *(once DNS is configured — see step 4)*
- Identity provider: pick one (Google Workspace / Microsoft / Okta) and bind.
- Policy "ICRV Operators": email allowlist or group binding for everyone who
  should reach the dashboard.
- Copy the **Application AUD** tag from the application's Overview tab.

Then in `workers/icrv-api/wrangler.toml` `[vars]`:

```toml
CF_ACCESS_TEAM_DOMAIN = "<team>.cloudflareaccess.com"
CF_ACCESS_AUD         = "<aud-tag>"
```

Pages → `icrv-dashboard` → Settings → Environment Variables (Production):

```
VITE_CF_ACCESS_TEAM_DOMAIN = <team>.cloudflareaccess.com
VITE_CF_ACCESS_AUD         = <aud-tag>
```

### 3. Operator users in D1 (PR 6)

For every email Cloudflare Access lets through, insert a matching `users` row.
Cloudflare Access only checks "is this email allowed in"; the worker's
`resolveUser()` then maps the email to a tenant and a role.

```sql
INSERT INTO users (id, tenant_id, email, role, status)
VALUES ('user_…', 'tenant_…', 'lower@example.com', 'admin', 'active');
```

Missing rows yield HTTP 403 `user_not_provisioned` (the SignIn panel surfaces
this).

### 4. DNS (PR 7 cutover)

- Point `app.icrv.app` → the Pages project (custom domain in Pages settings).
- Point `api.icrv.app` → the `icrv-api` worker (Workers Routes or Custom Domain).
- After both resolve and serve 200, follow **PR 7 cutover** below.

### 5. Sentry DSNs (PR 4)

Create two Sentry projects:

- **icrv-frontend** (platform: React)
- **icrv-workers** (platform: Cloudflare Workers — one DSN reused by all 4
  workers; events are tagged with the worker's `service` field)

Then:

```
wrangler secret put SENTRY_DSN --name icrv-api
wrangler secret put SENTRY_DSN --name icrv-hooks
wrangler secret put SENTRY_DSN --name icrv-voice
wrangler secret put SENTRY_DSN --name icrv-agent
```

Pages → `icrv-dashboard` → Settings → Environment Variables (Production):

```
VITE_SENTRY_DSN = <react-project DSN>
```

### 6. PR 7 cutover commit (do this only after DNS is live)

When `app.icrv.app` and `api.icrv.app` are both serving 200, apply this diff
on a new branch (`hardening/07-final-cutover`) and deploy:

```diff
--- a/workers/icrv-api/src/index.ts
+++ b/workers/icrv-api/src/index.ts
 export const CORS_ALLOWLIST: ReadonlySet<string> = new Set([
   'https://app.icrv.app',
   'http://localhost:5173',
-  'https://icrv-dashboard.pages.dev',
 ]);
```

```diff
--- a/workers/icrv-api/src/auth.ts
+++ b/workers/icrv-api/src/auth.ts
 const BROWSER_ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
   'https://app.icrv.app',
   'http://localhost:5173',
-  'https://icrv-dashboard.pages.dev',
 ]);
```

```diff
--- a/frontend/wrangler.toml
+++ b/frontend/wrangler.toml
-VITE_API_BASE_URL = "https://icrv-api.americanironadmin.workers.dev"
+VITE_API_BASE_URL = "https://api.icrv.app"
```

After deploying, also submit `app.icrv.app` to <https://hstspreload.org> if
you want browser HSTS preload eligibility.

### 7. Post-cutover verification

```
PREVIEW=https://app.icrv.app
API=https://api.icrv.app
bash scripts/audit-check.sh "$PREVIEW" "$API"
PREVIEW_URL="$PREVIEW" npm run audit:a11y    # zero Serious / Critical
```

---

## Backlog — not in PR 1–7

Items observed during the run that are out of scope for the current audit and
should be filed as separate tickets.

1. **Remove `/dev/gen-token` endpoint** — done in cutover Phase A; regression
   test at `workers/icrv-api/src/__tests__/no-dev-token.spec.ts` keeps it gone.

2. **Favicon ICO/PNG (L1)** — needs a real binary asset (a 32×32 `.ico` and a
   180×180 `apple-touch-icon.png`). Generate from `frontend/public/favicon.svg`
   in an image editor and drop into `frontend/public/`. The `<head>` will need
   the corresponding `<link rel="icon" href="/favicon.ico" sizes="any">` and
   `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` tags.

3. **`eslint-plugin-jsx-a11y`** — the audit's L4 follow-up suggested adding
   this. The frontend currently has no ESLint config at all; bringing one up
   should ship with the a11y fixes when `npm run audit:a11y` is run for the
   first time.

4. ~~**CSP enforcing-mode flip (PR 2 / Phase D follow-up)**~~ **(closed 2026-05-04, PR `polish/csp-enforce-flip`)** — flipped via autonomous Playwright walk against the unique-hash Pages preview URL `<hash>.icrv-dashboard.pages.dev` (which serves the same `_headers`/CSP as production but isn't covered by Access's exact-hostname destination match). Walk script committed at `frontend/scripts/csp-walk.spec.ts` is re-runnable for future audits via `PLAYWRIGHT_TEST_BASE_URL=<preview-url> npx playwright test` from `frontend/`. Note: the original recipe assumed `wrangler tail | grep csp-report` would catch worker-side reports, but `/csp-report` now sits behind Access (after the cutover-time destination consolidation), so worker-tail capture is no-op for browser-initiated CSP reports — the browser-side `page.on('request')` capture in the spec is the authoritative channel.

5. **Sentry session replay** — currently disabled by default. If you decide
   replay is acceptable after a privacy review, flip the
   `replaysSessionSampleRate` in `frontend/src/main.tsx`.

6. **Pre-existing typecheck error** — fixed in PR 1 commit (`existing!.id` in
   dead code at `workers/icrv-api/src/routes/misc.ts`). Worth a real fix to
   delete the dead branch entirely, but out of scope.

7. **Sentry DSNs (PR 4)** — the SDK is wired but DSNs are empty everywhere.
   Once Sentry projects exist, run:
   ```
   for w in icrv-api icrv-hooks icrv-voice icrv-agent; do
     echo "<workers DSN>" | wrangler secret put SENTRY_DSN --name $w
   done
   ```
   Then add `VITE_SENTRY_DSN` to the Pages environment-variable set
   (Cloudflare → Pages → icrv-dashboard → Settings → Environment Variables).

8. **OAuth callback hostname (icrv-api/src/index.ts)** — both the
   `redirect_uri` baked into the Google OAuth request and the `frontendBase`
   used to redirect after a successful exchange are still `*.workers.dev` in
   one place and `icrv.americanironus.com` in another. Long-term: pin all
   three to `icrv-api.americanironus.com` for the request and
   `icrv.americanironus.com` for the post-exchange redirect, and update the
   Authorized Redirect URI in Google Cloud Console accordingly.

9. **`icrv-dashboard.pages.dev` allowlist transitional entry** — the CORS
   allowlist in `workers/icrv-api/src/index.ts` and `BROWSER_ALLOWED_ORIGINS`
   in `auth.ts` still include the legacy `pages.dev` hostname so PR-7
   preview deploys can hit the API. After the next preview run wraps,
   delete the line in both files and redeploy.

10. **a11y end-to-end run** — `axe-core/cli` couldn't run from public network
    (Access intercepts) and the bundled chromedriver/Chrome versions don't
    match locally. Run from inside the Access boundary:
    ```
    npx browser-driver-manager install chrome
    PREVIEW_URL=https://icrv.americanironus.com npm run audit:a11y
    ```
    Or paste a CF_Authorization service-token cookie into axe via
    `--include-tags` extensions.

11. **Pages 404 status quirk** — branch deploys at
    `<id>.icrv-dashboard.pages.dev` were observed serving `HTTP/2 200` for
    unknown routes despite `_redirects /* /index.html 404`. Production deploy
    at `icrv.americanironus.com` should honour it; verify after the manual
    walk in #4 above.

---

## Suggested next audit

Schedule a re-audit **30 days post-cutover** to look at:

- Production traffic patterns (are 120/60s/IP+tenant the right limits?)
- A11y under real screen readers (axe-core only catches static violations)
- CSP report volume (any third-party sources legitimately need allowlisting?)
- Sentry signal-to-noise (sample rate, fingerprinting, alert thresholds)
- D1 query plans on the now-realistic dataset

---

## Cutover log

Chronological record of every state-changing action in the cutover sprint
(per `CC-PROMPT-icrv-cutover.md`). Times are UTC.

### 2026-05-04 — Phase A (autonomous prep)

- `02:00Z` Branch state verified: 8 hardening commits on `main`, 7 PR branches present, working tree clean.
- `02:00Z` GitHub remote created — private `americaniron/icrv` (https://github.com/americaniron/icrv). Pushed `main` + all `hardening/*` branches.
- `02:01Z` Provisioned `KV_REVOKED` (id `09db5d58b02948a4ad5d60536dfbab01`) and `KV_JWKS` (id `42576af6e50642f492fc1cc03c5f1e7b`); ids written to `workers/icrv-api/wrangler.toml`. Commit `95edc99 chore(infra): bind KV_REVOKED and KV_JWKS namespaces`.
- `02:02Z` Deleted `GET /dev/gen-token` HS256-mint backdoor from `workers/icrv-api/src/index.ts`; added regression spec at `workers/icrv-api/src/__tests__/no-dev-token.spec.ts` (greps source for `/dev/`, `gen-token`, `X-Dev-Key`, `icrv_dev_bootstrap`). `@types/node` added to `workers/icrv-api` for the spec. Commit `f718518 chore(security): remove dev token mint backdoor (closes leftover from C1)`. Tests now 5/5 (3 role-gate + 2 no-dev-token).
- `02:03Z` Created branch `hardening/07-final-cutover` with the prepared 3-line diff (`CORS_ALLOWLIST` + `BROWSER_ALLOWED_ORIGINS` minus `icrv-dashboard.pages.dev`; `frontend/wrangler.toml` `VITE_API_BASE_URL` → `https://api.icrv.app`). Pushed to origin. Will only merge into `main` on Phase E `dns-live`.
- `02:04Z` Baseline audit-check captured against existing **production** (pre-hardening code, 6 days old):

```
=== Security headers (PR 1, PR 2) ===
x-content-type-options: nosniff   # only this — no CSP, HSTS, X-Frame-Options, etc.

=== Cache headers on hashed assets (PR 1) ===
cache-control: public, max-age=0, must-revalidate   # H1 still open

=== robots.txt is real text (PR 1) ===
content-type: text/html; charset=utf-8   # SPA fallback returning HTML

=== 404 returns 404 (PR 1) ===
HTTP/2 200    # H5 still open

=== API requires auth ===
  /v1/contacts                             401
  /v1/dashboard/status                     401
  /v1/admin/integrations                   401
  /v1/agent-controls/kill-switch           401
  /v1/auth/me                              401

=== Rate limit kicks in (PR 3) ===
  401 ×25, no 429   # C5 still open on prod

=== CORS reflects with Vary (PR 3) ===
access-control-allow-origin: https://app.icrv.app   # no Vary: Origin (M2)

=== No legacy token storage in bundle (PR 6) ===
 icrv_token occurrences in bundle: 2 (expect 0 after PR 6)

=== Sentry initialized in bundle (PR 4) ===
 sentry references: 0 (expect >0)
```

This confirms the hardening code has not yet been promoted to production —
exactly what Phase C / Phase E will fix.

- `02:05Z` Favicon ICO/PNG generation **skipped** — neither `magick`, `convert`, nor `sharp` is available locally. Backlog item carries forward.

### 2026-05-04 — Phase C (apply config)

- `02:55Z` Phase B input received: team `americanironadmin.cloudflareaccess.com`, AUD provided as a UUID (initially), one operator `adam@americaniron1.com,admin`, Sentry skipped, tenant auto-detect.
- `02:56Z` Wrangler config updated: `workers/icrv-api/wrangler.toml [vars]` and `frontend/wrangler.toml [vars]` populated with the team domain + AUD. Committed `e582a27 chore(infra): populate Cloudflare Access vars`.
- `02:57Z` D1 tenant detection: 1 row found (`tenant_americaniron_001` "American Iron LLC") — used. `INSERT OR IGNORE` on user — already present from earlier bootstrap (`user_admin_001` adam@americaniron1.com admin tenant_americaniron_001 active).
- `02:58Z` **icrv-api production deployed** (version `736c0319-86d6-42ac-9b01-3efc44fdc29e`, ~91 KB gzip) on user-confirmed option A. Ten KV bindings, all queues, all R2 buckets, all DOs, both service bindings, vars including the new CF_ACCESS_*.
- `02:59Z` Smoke test discovery: Cloudflare Access is **already deployed in front of the entire `icrv-api.americanironadmin.workers.dev` worker**. Every request — including `/health`, `/csp-report`, `/oauth/google/callback` — returns 302 to the Access login. The redirect's meta-JWT exposed the **real** AUD: `cc08483a7cec7b0b502d7816b85ac844f11ae6dc874e55e01ea677902deeadae` (the value the user originally pasted was the UUID-shaped Application ID).
- `02:59Z` Updated `CF_ACCESS_AUD` / `VITE_CF_ACCESS_AUD` to the real 64-char AUD; redeployed icrv-api (version `7b993f6b-2fae-414e-9103-1a28fb390556`). Committed `10eac4c fix(infra): correct CF_ACCESS_AUD`.
- `03:00Z` Frontend rebuilt with VITE_* env vars passed inline (Vite reads `import.meta.env.*` from the shell at build time, not from `wrangler.toml [vars]` which only reaches Pages Functions runtime). AUD + team domain confirmed baked into bundle.
- `03:01Z` Pages preview deployed via `wrangler pages deploy dist --project-name icrv-dashboard --branch hardening-cutover`. Live at `https://hardening-cutover.icrv-dashboard.pages.dev` (alias) / `https://b7662fdc.icrv-dashboard.pages.dev` (deployment URL).
- `03:01Z` Post-deploy audit-check (preview Pages + production icrv-api):

```
=== Security headers ===
strict-transport-security: max-age=31536000; includeSubDomains; preload  ✓
content-security-policy-report-only: <full v1 policy>                    ✓ (Report-Only)
cross-origin-opener-policy: same-origin                                  ✓
permissions-policy: camera=(), microphone=(), geolocation=(), …          ✓
x-content-type-options: nosniff                                          ✓
x-frame-options: DENY                                                    ✓

=== robots.txt ===
content-type: text/plain; charset=utf-8                                  ✓
cache-control: public, max-age=3600                                      ✓

=== API Access enforcement ===
/v1/contacts /v1/dashboard/status /v1/admin/integrations
/v1/agent-controls/kill-switch /v1/auth/me   →   all 302 to Access login ✓

=== Known gaps ===
- 404 status: hardening-cutover.icrv-dashboard.pages.dev returns HTTP 200 for
  unknown routes despite _redirects /* /index.html 404 — known Pages quirk on
  branch deploys; production deploy at icrv-dashboard.pages.dev should honor it.
- Rate limit / Vary tests blocked: Access intercepts at the edge before our
  worker code runs, so rate-limit middleware and CORS Vary header don't appear.
  These will be reachable again once an Access bypass is configured for the
  unauthenticated public endpoints (/health, /csp-report, /oauth/google/callback)
  or the Access app is scoped to /v1/* only.
```

### 2026-05-04 — Phase D ("hold" path chosen)

- `03:10Z` After Phase C smoke-testing surfaced that Cloudflare Access was gating the *entire* `icrv-api.americanironadmin.workers.dev` worker (including `/health`, `/csp-report`, `/oauth/google/callback`), surfaced three options to the user: (1) add `*.icrv-dashboard.pages.dev` + bypass policies, (2) skip walkthrough and go to Phase E, (3) limited Phase D now.
- `03:30Z` User chose `hold` route: scope-narrow Cloudflare Access on `icrv-api.americanironus.com` to `/v1/*` only. Outcome: `/health`, `/csp-report`, `/oauth/google/callback` are now publicly reachable while every authenticated route remains gated.
- `03:35Z` User confirmed scope-narrowing works:
  - `GET /health` → `HTTP/2 200, application/json` (worker-served, public)
  - `GET /v1/contacts` → `HTTP/2 302` to Cloudflare Access (still gated)
- The CSP-walk portion of Phase D is **deferred** to a post-cutover manual step: log into Access, walk every sidebar route in DevTools with `wrangler tail --name icrv-api | grep csp-report` open in a second terminal, then push a follow-up commit changing `Content-Security-Policy-Report-Only` → `Content-Security-Policy` in `frontend/public/_headers`. Backlog item recorded.

### 2026-05-04 — Phase E (DNS-gated final cutover)

- `03:39Z` Pre-cutover verification A–I (J was a stray cutoff in the user's message). All checks passed: DNS resolves to Cloudflare edge (Replit conflict cleared), Access gates the new hostnames with the correct AUD, `hardening/07-final-cutover` rebuilt fresh on top of `main` with the correct `americanironus.com` hostnames, no stale baselines.
- `03:46Z` User typed `dns-live` after confirming the Access scope-narrowing worked.
- `03:47Z` `git merge --no-ff hardening/07-final-cutover` into `main` (commit `92bb577`); pushed origin.
- `03:49Z` **icrv-api production redeployed** (version `a053e4d3-3649-445c-9991-e06f60d3a4ae`) with the corrected CORS allowlist (`https://icrv.americanironus.com` replacing `https://app.icrv.app`).
- `03:50Z` **frontend Pages production deployed** to branch `main`. Build env: `VITE_API_BASE_URL=https://icrv-api.americanironus.com`, `VITE_CF_ACCESS_TEAM_DOMAIN=americanironadmin.cloudflareaccess.com`, `VITE_CF_ACCESS_AUD=cc08483a7cec…`. Bundle verified: 2 occurrences of new API hostname baked in, 0 references to legacy `icrv_token`. Deployment URL: `https://36a4f502.icrv-dashboard.pages.dev` (aliased to custom domain `https://icrv.americanironus.com`).
- `03:50Z` Final post-cutover verification:

```
=== Pages root + AuthGate redirect ===
HTTP/2 302
location: https://americanironadmin.cloudflareaccess.com/cdn-cgi/access/login/icrv.americanironus.com?...
server: cloudflare

=== API /health (public per Access scope-narrowing) ===
HTTP/2 200
{"ok":true,"service":"icrv-api","ts":"2026-05-04T03:50:39.160Z"}

=== API /v1/* still gated by Access ===
  /v1/contacts                             302
  /v1/dashboard/status                     302
  /v1/admin/integrations                   302
  /v1/agent-controls/kill-switch           302
  /v1/auth/me                              302

=== /csp-report public (Access bypass works) ===
204                                        ← worker received the test POST

=== CORS preflight reflection ===
HTTP/2 200
access-control-allow-origin: https://icrv.americanironus.com   ← new hostname allowlisted
vary: Origin                                                    ← M2 still closed
access-control-allow-credentials: true

=== Worker version pin ===
2026-05-04T03:49:08.066Z   americanironadmin@icloud.com   a053e4d3-3649-445c-9991-e06f60d3a4ae
```

- `03:53Z` axe-core a11y check **could not run end-to-end** — two reasons: (a) bundled `chromedriver 148` versus locally installed Chrome 136 (`session not created`), and (b) Access intercepts the page before axe-headless can render, so even with a matching ChromeDriver the tool would only see the Access login screen. Deferred to a manual local pass with a logged-in browser. Backlog item recorded.

### 2026-05-04 — Polish: CSP enforcing flip (Backlog #4 closed)

- `13:30Z` Service-token walk attempt blocked: the ICRV Access Application has been migrated to the new OAuth 2.0 Protected Resource mode (`www-authenticate: Bearer realm="OAuth"`, `authentication_methods: [cloudflared, oauth]`). Legacy `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers no longer authenticate. Switched approach to walking the unique-hash Pages preview URL, which serves the same `_headers` but isn't covered by Access's exact-hostname destination match.
- `13:30Z` Playwright walk against `https://36a4f502.icrv-dashboard.pages.dev` (current `main` deployment, still Report-Only): zero real violations across `/`, `/contacts`, `/campaigns`, `/ai`, `/logs`, `/calls`, `/settings` + Contacts modals (`+ New Contact`, `⇑ Bulk CSV`). `/v1/auth/me` mocked in-spec so AuthGate flips authed and routes render. Seven advisories observed (`'upgrade-insecure-requests' is ignored when delivered in a report-only policy`) are browser informationals that disappear post-flip — filtered out of the violation set.
- `13:46Z` `frontend/public/_headers` flipped to enforcing via `sed`. Substitution verified: `Content-Security-Policy-Report-Only` count = 0; `^  Content-Security-Policy:` count = 1.
- `13:48Z` Production redeploy: `wrangler pages deploy dist --project-name icrv-dashboard --branch main`. New deployment URL `https://f40eefbb.icrv-dashboard.pages.dev`.
- `13:49Z` Header on the new deploy verified by `curl -sI`: `content-security-policy: default-src 'self'; ...` (no `-Report-Only` suffix).
- `13:50Z` Confirmation walk against the new ENFORCING deployment: zero blocks across the same 7 routes + Contacts modals, proving the policy doesn't break anything under enforcement.
- `13:51Z` `bash scripts/audit-check.sh https://f40eefbb.icrv-dashboard.pages.dev https://icrv-api.americanironus.com` — security headers section emits the expected enforcing CSP, HSTS, COOP, Permissions-Policy, X-Frame-Options DENY, X-Content-Type-Options. (Custom domain `icrv.americanironus.com` cannot be audited from outside Access since Access now protects the bare host; the unique-hash URL serves the same artifacts.)
- `13:52Z` Walk artifacts committed: `frontend/playwright.config.ts`, `frontend/scripts/csp-walk.spec.ts`, `frontend/scripts/csp-walk-results.json`. Local `.csp-walk.env` will be removed after the merge.

### 2026-05-04 — Functional smoke test (deferred) + campaign-builder fixes

Ran `CC-PROMPT-icrv-functional-smoke.md` end-to-end discovery (Phase A) before the
user-driven UI test (Phase C). Phase C was deferred in favour of a small set of
fixes that block any meaningful test today.

**Phase A — operational state (read-only):**
- All 8 workers deployed; latest version IDs captured in cutover log; `wrangler tail` confirmed reachable.
- Secrets present per worker: `GOOGLE_CLIENT_ID/SECRET` on api/agent/email/consumer; `MASTER_KEK` everywhere; `JWT_SIGNING_KEY` on api; `ANTHROPIC_API_KEY` on agent/voice/consumer; `WA_*` split across whatsapp/hooks/consumer; `RC_JWT` + `EL_API_KEY` + `EL_LLM_SHARED_SECRET` on voice; `EL_WEBHOOK_SECRET` + `RC_WEBHOOK_TOKEN` on hooks; `icrv-cron` has no secrets (expected).
- D1 state: 1 tenant (`tenant_americaniron_001`), 1 admin user, 1 contact (`icrv-test-self-001`, adam@americaniron1.com), 0 templates, 0 consents, 2 campaigns (1 cancelled / 1 draft), 1 sent message (manual `/send` POST from 2026-04-28), 0 agent_runs, 0 agent_actions, 6 audit_logs.
- Active integrations rows: `oauth_tokens` provider=gmail (active, email=adam@americaniron1.com); `api_credentials` provider in {gmail, ringcentral, elevenlabs} (active); WhatsApp has no api_credentials row → not testable.
- Public surface: every endpoint returns 401 to anonymous curls — expected because Access is in OAuth Protected Resource mode (matches the post-CSP-flip state). CSP enforcing still active.

**Root-cause diagnosis of the previously failed campaign:**
- Campaign `180a872e-d47c-45f2-8c75-18d3affeae41` was launched at `2026-05-03T08:08:45.695Z` and cancelled at `08:08:51.094Z` — **5.4 seconds later**.
- `icrv-cron` campaign tick is `* * * * *` (once per minute on the boundary). No tick fired in the 5.4-second active window, so `agent_runs` was never written. By the next tick, both `campaign.status` and `enrollment.status` had flipped, so the cron's `WHERE active AND active` join filtered the row out.
- Independently, the campaign step had `credential_id=NULL` and `template_id=7dc1b66a-…` pointing at a template that no longer exists in `templates`. Even with the cron timing fixed, the step would have been malformed — though in practice `workers/icrv-agent/src/context-loader.ts:330` resolves the email's `oauth_token_id` directly from `oauth_tokens` by tenant and ignores the step's `credential_id`, so the immediate sender path would still have worked once the cron picked it up. The credential-id field is informational, not load-bearing for email today.

**UI gaps that pre-loaded this trap:**
- `frontend/src/pages/Campaigns.tsx` declared a `credentials` state but never fetched anything to populate it. The credential field rendered as a free-text UUID input — no dropdown, no auto-bind from `/v1/admin/integrations`, no link to Settings if disconnected.
- The `templates` table is empty in production, so the Template `<select>` is also empty — operators can't add a step without first creating a template via the Templates page.

**Fixes applied in this commit (no schema/secret changes):**
- Reused the existing `GET /v1/admin/integrations` endpoint (returns `gmail.oauth_token_id`, `whatsapp.credential_id`, `ringcentral.credential_id`, `elevenlabs.credential_id`) instead of adding a new credentials route.
- Added `credentialForChannel()` helper in `Campaigns.tsx` that maps the campaign channel to the right integration key (email→gmail.oauth_token_id, whatsapp→whatsapp.credential_id, voice→ringcentral.credential_id; ElevenLabs is resolved server-side by the agent).
- `CampaignForm` now fetches integrations alongside templates, auto-binds `stepForm.credential_id` whenever channel changes or integrations finish loading, and replaces the free-text input with a read-only "Sending from" field that shows a green `connected` badge + the account label, or a "Connect X in Settings" hint when the relevant provider isn't wired up. Validation toast is split so missing template vs missing credential give the right message.
- Post-launch toast now includes "First message dispatches within 60 seconds — give it a minute before pausing or cancelling." This is operational guidance for the cron-tick race; the structural fix (have `/launch` enqueue an immediate Q_AGENT job for due enrollments) is filed in the backlog as a follow-up.

**Verification:** `cd frontend && npx tsc --noEmit` clean; `npm run build` clean (640 modules, 4 chunks, 959ms). No worker code changed, so worker test suites unchanged.

**Backlog items added by this pass:**
1. Have `POST /v1/campaigns/:id/launch` (or `CampaignCoordinatorDO`) enqueue an immediate Q_AGENT message for any enrollment whose `next_step_at <= now`, instead of relying on the next cron tick. This eliminates the "cancel within 60s wins the race" failure mode entirely.
2. The campaign form's "Inline Email Template (optional)" subject/body fields in Step 0 are not sent on submit — they're collected in state but never used. Either wire them through (auto-create a template before posting the campaign) or remove the UI to avoid confusion.
3. Seed at least one default email template per tenant on provisioning so the Steps `<select>` is never empty for new tenants.
4. WhatsApp has secrets on `icrv-whatsapp` but no `api_credentials` row for the tenant, and `WA_ACCESS_TOKEN` lives on `icrv-hooks`/`icrv-consumer` but not on `icrv-whatsapp` itself — re-verify the bootstrap flow (`POST /v1/admin/integrations/whatsapp`) actually wires both before attempting a WA smoke test.

### 2026-05-04 — Backlog #1, #2, #3 closed

Three follow-up items from the campaign-builder pass, fixed in one commit:

1. **Immediate-launch enqueue (Backlog #1):** `POST /v1/campaigns/:id/launch`
   now mirrors `runCampaignTick`'s per-enrollment work for step 0 — checks
   `CampaignCoordinatorDO.can-send`, inserts `agent_runs`, advances the
   enrollment, and sends to `Q_AGENT` — instead of leaving the enrollment for
   the next minute-boundary cron tick. Eliminates the race that previously
   dropped any campaign cancelled within ~60s of launch. Per-enrollment errors
   are caught and logged so they don't fail the whole launch — the cron retains
   its retry behaviour as a backstop. Response now includes `dispatched`
   alongside `enrolled`.
2. **Inline-template wiring (Backlog #2):** `CampaignForm.handleSubmit` now
   detects the inline-template shortcut (channel=email, no manual steps,
   subject + body_html filled) and on submit creates the template via
   `campaignsApi.createTemplate`, then auto-adds a single step that uses it
   bound to the connected Gmail oauth_token_id with delay=0. Steps tab is now
   optional for the common "one email, send now" case.
3. **Default templates on tenant provisioning (Backlog #3):** New idempotent
   `POST /v1/admin/bootstrap-templates` endpoint seeds three default
   templates per tenant (email intro, WhatsApp `hello_world`, voice script).
   Skips any channel that already has a template. Existing
   `tenant_americaniron_001` seeded post-deploy via the equivalent SQL run
   through `wrangler d1 execute` (calling the endpoint directly requires an
   Access OAuth bearer that isn't easily produced from a CLI session).
   - Result: WhatsApp + Voice defaults inserted; **email skipped** because
     a pre-existing template `7dc1b66a-…` "Heavy Equipment Intro" already
     occupied that channel slot. That template has `body_html=null` and
     `body_text=null` (empty body) — a separate gotcha that the bootstrap's
     coarse "any-template-exists" guard cannot detect. Users can route
     around this via the new inline-template flow on the campaign form
     (Backlog #2 above), which creates a fresh, valid template per campaign.

**Verification:** `tsc --noEmit` clean for icrv-api + frontend; `npm test` clean
for icrv-api (5 passed); `vite build` clean (640 modules). No schema or secret
changes; bindings on icrv-api (`Q_AGENT`, `CAMPAIGN_DO`) were already present.

## Make-it-real log

- **2026-05-05** — EL ↔ ICRV LLM-proxy pre-flight (no phone): Tests 1, 2 PASS;
  Tests 3, 4, 5 FAIL. Blockers: (a) EL_LLM_SHARED_SECRET worker/runtime mismatch,
  (b) EL_API_KEY lacks `convai_read` scope, (c) Test 5 blocked by (b). Phase H
  voice test NOT safe until all three fixed. Full log:
  `smoke-tests/el-wiring-20260505T165708Z.log`.
- **2026-05-06** — Test 3 re-run after `wrangler secret put EL_LLM_SHARED_SECRET`
  + redeploy (version f0085638): PASS. Worker returned HTTP 200 with valid
  OpenAI-shaped `chat.completion` and `choices[0].message.content == "OK"`.
  Proxy side fully wired. Remaining blockers: EL_API_KEY needs `convai_read`
  scope (Test 4), and the agent's published Custom LLM Server URL must be
  pasted in the EL dashboard pointing at
  `https://icrv-voice.americanironadmin.workers.dev/llm/v1` with the new bearer
  (Test 5).
- **2026-05-06** — Tests 4 & 5 re-run after user granted `convai_read` to
  EL_API_KEY and published the agent draft (flipping `prompt.llm` from
  `glm-45-air-fp8` to `custom-llm`, setting `prompt.custom_llm.url` to
  `https://icrv-voice.americanironadmin.workers.dev/llm/v1`,
  `model_id=claude-haiku-4-5-20251001`, with the bearer stored in EL
  secret store at `secret_id=joah3aGjjl325uoTO50I`): both PASS. **Overall
  verdict: READY for Phase H voice test.** EL agent
  `agent_5401kq1w1ecxed28a144qm9btd40` ("Outbound Dialer with Voicemail
  Handling") has a Gemini 3.1 Pro Preview backup LLM configured — during
  Phase H, tail `wrangler tail --name icrv-voice` to confirm Claude Haiku
  actually serves turns rather than the silent fallback.
- **2026-05-06** — Live in-browser conversation test against
  `agent_5401kq1w1ecxed28a144qm9btd40` confirmed working end-to-end after
  removing two stale tool refs from `workflow.nodes.live.additional_tool_ids`
  that were blocking EL's "Test AI agent" widget with "Documents with ids
  ... not found". Brain wiring now verified by both API checks (Tests 1-5)
  and a live conversational round-trip. Phase H voice test is safe to run.

## 2026-05-06 — Make-it-real verification

Branch: `ops/make-real` (merged to `main` in this run).

### Test matrix

| Capability | Result | Evidence |
|---|---|---|
| D1 schema integrity | PASS | 25 tables present, 0 orphans, 1 tenant `tenant_americaniron_001`, 1 admin user, 5 api_credentials (3 active: gmail/ringcentral/elevenlabs) |
| D1 backup cron live | PASS | `0 3 * * *` schedule wired in `icrv-cron`. Manual trigger via `/admin/run-d1-backup` produced `r2://icrv-exports/d1-backups/icrv-db-2026-05-06.sql` (34,066 bytes, all 24 tables, valid SQL) |
| Email send (Gmail) | PASS | Campaign `ca801c4a-…` enrolled `__SMOKE_EMAIL_…` and `icrv-test-self-001`; both `messages.status='sent'`; user confirmed delivery to `adam@americaniron1.com` |
| WhatsApp send | DEFERRED | `WA_ACCESS_TOKEN` not set on icrv-whatsapp; user typed "skip" |
| Voice + AI sales agent | DEFERRED | Per user instruction at Phase C ask. Brain wiring already proven in prior session (Tests 1–5 PASS + live in-browser conversation). Phone-call leg awaits a follow-up run with RingCentral SIP exercised |
| Kill switch enforcement | PASS | After fixing two latent bugs (below), full toggle-OFF→Save→toggle-ON cycle verified. Audit log shows `kill_switch_deactivated` → `controls_updated:tenant` (kill_switch preserved) → `kill_switch_activated`. D1 row's `controls_json.kill_switch` flips correctly each time |
| Consent enforcement | PASS | `__SMOKE_BLOCKED_…` (consent_state='revoked' on email) was enrolled in same campaign. agent_run row has `status='blocked_by_policy'`; 0 messages dispatched to that contact |
| Dashboard metrics | PASS | User reported tile values `3 / 1 / 3 / 0 / 1 / 3` matching D1: contacts=3, active_campaigns=1, emails_sent=3, whatsapp=0, calls=1, ai_actions/runs=3 |

### Bugs found & fixed during the run

1. **Cloudflare Access blocking CORS preflight** on `icrv-api.americanironus.com`
   - OPTIONS to any write endpoint returned 403 (HTML Access page) → axios reported "Network Error"
   - Fix: enable CORS in the Access app (allow methods, origins, headers, credentials)
   - Resolved: 2026-05-06 by user in CF Zero Trust dashboard

2. **Kill-switch route shadowed by `/:scope`** in `workers/icrv-agent/src/control-panel.ts`
   - `app.delete('/:scope')` was registered before `app.delete('/kill-switch')` → Hono captured `kill-switch` as the scope param, deleted zero rows, returned 200 with misleading `controls_deleted:kill-switch` audit
   - Fix: hoisted POST/DELETE `/kill-switch` above the parameterized routes; added `VALID_SCOPES` guard to DELETE `/:scope` as defense-in-depth
   - Commit: `c74043e`

3. **Frontend stale draft reverting kill switch on Save** in `frontend/src/pages/AIControlPanel.tsx`
   - useEffect dep was `[tenantControl?.id]`, so toggling kill switch (same row id) didn't re-sync draft → clicking Save pushed stale `kill_switch:true` back to D1, undoing the toggle
   - Fix: `handleKillSwitch` now `setDraft(d => ({...d, kill_switch: <new>}))` immediately
   - Commit: `c74043e`

### Deferred (not tested this run)

- **WhatsApp** — needs `WA_ACCESS_TOKEN` on icrv-whatsapp + an approved Meta Business message template. ~30 min in Meta Business + 1 wrangler secret put.
- **Voice / phone-ring** — RC SIP→EL audio bridge unverified by phone test. Brain side already proven (HTTP-level + browser conversation). To run Phase H, a follow-up run with the user's phone available + Phase H from `CC-PROMPT-icrv-make-it-real.md`.

### Manual steps still on you

1. **R2 lifecycle rule** for `d1-backups/` — Cloudflare → R2 → `icrv-exports` → Settings → Object lifecycle rules → "Delete after 30 days" with prefix `d1-backups/`. ~30 sec; without it, backup blobs accumulate.
2. **Cost caps** on integrations:
   - ElevenLabs: Profile → Subscription → Usage limits
   - RingCentral: Account → Billing → Notifications
   - Anthropic: console.anthropic.com → Limits
3. **WhatsApp setup** if/when you want that channel — see Deferred above.
4. **Phase H voice test** when phone available — re-run `CC-PROMPT-icrv-make-it-real.md` § Phase H (skip A–G if state hasn't changed).

### Conclusions

Email + AI control plane is operationally proven end-to-end. Real campaign created, real email arrived, real consent gate blocked the no-consent contact, real kill switch toggle persisted to D1 and would block dispatch, real D1 backup landed in R2. Three latent bugs found and fixed during the run (CORS, route-shadow, frontend draft-sync). Voice and WhatsApp deferred but with clear unblock paths. Production ready for email-only outbound; voice and WhatsApp need targeted follow-ups.

## Verification one-liners (cheat sheet)

```bash
# Workspace + frontend typecheck
npm run typecheck && (cd frontend && npx tsc --noEmit)

# Worker tests
(cd workers/icrv-api && npm test)

# Frontend prod build
(cd frontend && npm run build)

# Post-deploy audit recipe
bash scripts/audit-check.sh https://<pages> https://<api>

# A11y sweep
PREVIEW_URL=https://<pages> npm run audit:a11y
```
