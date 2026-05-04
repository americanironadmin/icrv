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
| C3 | Critical | Auth | PR 2 (CSP) + PR 6 (cookie cutover) | CSP Report-Only on `_headers` + Access cookie path only | `curl -sI <pages>/contacts \| grep content-security-policy` |
| C4 | Critical | Headers | PR 1, PR 2 | `frontend/public/_headers` — HSTS, X-Frame-Options DENY, Permissions-Policy, COOP, X-Content-Type-Options, Referrer-Policy, CSP | `curl -sI <pages>/contacts \| grep -iE "strict-transport\|x-frame\|permissions-policy\|cross-origin-opener\|content-security-policy"` |
| C5 | Critical | API | PR 3 | `packages/shared/src/rate-limit.ts` + `workers/icrv-api/src/index.ts` — 10/60s on `/v1/auth/*`, 120/60s on `/v1/*` | 25× burst returns 401s then 429s |
| C6 | Critical | Auth | PR 3 + PR 6 | `KV_REVOKED` + `/v1/auth/logout` + `authMiddleware` JTI check | Logout → JTI persisted → next request 401 token_revoked |
| C7 | Critical | Hosting | PR 6 (partial) → human cutover | Code is ready for `app.icrv.app` / `api.icrv.app`. The DNS + final CORS trim are described in **Manual steps** below | After DNS + CORS trim: `curl -sI https://app.icrv.app/` |
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

4. **CSP enforcing-mode flip (PR 2)** — the policy ships in
   `Content-Security-Policy-Report-Only` mode. After walking every route on
   preview and confirming `[csp-report]` worker logs are clean, push a follow-up
   commit on PR 2's branch (`hardening/02-csp`) replacing
   `Content-Security-Policy-Report-Only:` with `Content-Security-Policy:` in
   `frontend/public/_headers`.

5. **Sentry session replay** — currently disabled by default. If you decide
   replay is acceptable after a privacy review, flip the
   `replaysSessionSampleRate` in `frontend/src/main.tsx`.

6. **Pre-existing typecheck error** — fixed in PR 1 commit (`existing!.id` in
   dead code at `workers/icrv-api/src/routes/misc.ts`). Worth a real fix to
   delete the dead branch entirely, but out of scope.

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
