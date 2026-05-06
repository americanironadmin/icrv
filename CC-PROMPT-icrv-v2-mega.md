# Claude Code task — ICRV v2 mega: bug fixes + full feature parity, single autonomous session

You are operating MAXIMALLY AUTONOMOUSLY on `~/Documents/icrv`. The user wants every blocker fixed and every feature in the screenshots shipped in ONE session. They will not be available to answer questions mid-flight. You will:

1. Perform the single batched ask in Phase 0. If the user provides only some answers (or none, or just "build"), apply the defaults in this prompt and proceed.
2. Execute Phases 1–5 sequentially. Do not stop between phases. Do not ask for confirmation between phases. Self-deploy preview after each phase, self-test, self-fix any failures.
3. Stub or defer any feature that cannot ship cleanly. NEVER abort the session because one feature is hard. Stub it, document it, move on.
4. The ONLY reasons to stop are: (a) `wrangler` authentication is broken (you cannot deploy at all), (b) the user's git remote rejects pushes, (c) D1 is unreachable. Anything short of that — keep going.
5. After all five phases (or all that you could ship), produce a single final report and exit.

Target session duration: 12–30 hours of autonomous work. Do not optimize for speed at the cost of correctness; do not optimize for completeness at the cost of session-blocking on a single hard problem. Ship what you can ship.

## Read first

1. `HARDENING_REPORT.md` — what's already done. **DO NOT REDO ANY OF IT.**
2. `dns-rollback-snapshot.txt` (if user copied it; ignore if absent).
3. `frontend/src/index.css` — existing CSS variables, dark theme.
4. `workers/icrv-api/src/routes/contacts.ts` — current bulk-upload handler. Bug lives here OR in `icrv-consumer`.
5. `workers/icrv-consumer/src/index.ts` — current async job handler.
6. `schema.sql` + `migrations/` directory — D1 schema state.
7. `frontend/src/App.tsx` — top-level routes.

## Phase -1 — State discovery (ALWAYS run this FIRST, before Phase 0)

Before asking the user anything, before creating any infrastructure, before writing any code, RUN A FULL STATE-DISCOVERY PASS. The user has been through multiple prior sessions (hardening sprint, cutover, make-it-real, EL wiring, CSP flip). Most "setup" steps are already done. Discover what exists, record it in `V2_BUILD_REPORT.md` § "Pre-existing state", and SKIP redundant work.

```bash
cd ~/Documents/icrv

echo "=== git state ==="
git log --oneline -20
git branch -a | grep -v archive
git status --short

echo "=== KV namespaces (do NOT recreate any of these) ==="
wrangler kv namespace list 2>&1 | head -50

echo "=== R2 buckets ==="
wrangler r2 bucket list 2>&1 | head -20

echo "=== D1 databases ==="
wrangler d1 list 2>&1 | head -20

echo "=== D1 schema (already-applied tables) ==="
wrangler d1 execute icrv-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

echo "=== D1 active users + tenants ==="
wrangler d1 execute icrv-db --remote --command="SELECT email, role FROM users WHERE status='active'"
wrangler d1 execute icrv-db --remote --command="SELECT id, name FROM tenants"

echo "=== Worker deployments + secrets per worker ==="
for w in icrv-api icrv-agent icrv-email icrv-whatsapp icrv-voice icrv-hooks icrv-consumer icrv-cron; do
  echo "--- $w ---"
  (cd workers/$w 2>/dev/null && wrangler deployments list 2>&1 | head -2)
  (cd workers/$w 2>/dev/null && wrangler secret list 2>&1 | head -30)
done

echo "=== Custom domains live ==="
curl -sI https://icrv.americanironus.com/ | head -3
curl -sI https://icrv-api.americanironus.com/health | head -3

echo "=== HARDENING_REPORT.md sections ==="
grep -E "^##|^###" HARDENING_REPORT.md 2>/dev/null | head -40
```

After running, write to `V2_BUILD_REPORT.md` a "Pre-existing state" section with:
- KV namespaces that exist (do not recreate any of these — reuse IDs from `wrangler.toml` or look them up)
- Secrets that are set per worker (do not re-prompt or re-set unless user provides a NEW value in Phase 0)
- D1 tables that exist (do not redo migrations that are clearly already applied — verify by table name + column presence)
- Custom domains that are live (do not reconfigure)
- HARDENING_REPORT sections (the work they describe is DONE — do not redo)

Concretely, expect to find this state from prior sessions (verify, don't assume):
- KV namespaces: `KV_CONFIG`, `KV_OAUTH`, `KV_RATE`, `KV_IDEMP`, `KV_TRACK`, `KV_REVOKED`, `KV_JWKS`
- Worker secrets that should already be set: `MASTER_KEK`, `JWT_SIGNING_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `EL_API_KEY`, `EL_LLM_SHARED_SECRET`, `EL_AGENT_ID`, `ANTHROPIC_API_KEY`, `RC_JWT` (if voice configured)
- Operator: `adam@americaniron1.com` / admin / active under tenant `tenant_americaniron_001`
- Custom domains: `icrv.americanironus.com` (Pages), `icrv-api.americanironus.com` (Worker)
- Cloudflare Access: gating `/v1/*` on icrv-api, public bypass on `/health`, `/csp-report`
- D1 backup cron in icrv-cron, dumping to R2_EXPORTS daily 03:00 UTC
- HARDENING_REPORT.md status table: most C/H/M items closed; voice phone-leg deferred; WhatsApp deferred (Meta template approval)
- /dev/gen-token deleted, regression test in place
- CSP enforcing (not Report-Only)

If anything in that expected list is MISSING, surface it clearly in the V2_BUILD_REPORT pre-existing state section but do NOT auto-fix unless the missing piece directly blocks a v2 phase. The user knows what they have; you discover it.

## Idempotency rules (apply to EVERY setup command from here on)

These are non-negotiable. Violating them costs the user's time.

| Resource | Idempotent pattern |
|---|---|
| KV namespace | `wrangler kv namespace list \| jq -r '.[].title' \| grep -qx "NAME" \|\| wrangler kv namespace create NAME` |
| Worker secret | `(cd workers/X && wrangler secret list \| jq -r '.[].name' \| grep -qx "NAME") \|\| (echo "$VALUE" \| wrangler secret put NAME --name X)` — ONLY if user provided a new value |
| R2 bucket | `wrangler r2 bucket list \| jq -r '.[].name' \| grep -qx "NAME" \|\| wrangler r2 bucket create NAME` |
| D1 INSERT | `INSERT OR IGNORE INTO ...` or `INSERT ... ON CONFLICT(...) DO NOTHING` |
| Migration | Track applied migrations in `_migrations(filename, applied_at)` table; skip if already in there |
| Custom domain | Check `wrangler pages deployment list` / `wrangler.toml routes` first |
| Access policies | NEVER auto-modify. They're configured by the user in the dashboard. Only verify presence; surface if absent. |

If a setup step would be a no-op given existing state, log it as `ALREADY-CONFIGURED` in the cutover log and skip silently. Do not error.

## Decisions already made — do not deviate, do not ask, just do

### Architecture
- **Bulk upload fix:** chunked queue. POST stages CSV/XLSX-converted-to-CSV to `R2_UPLOADS/imports/{job_id}.csv`, inserts row in new `import_jobs` table, enqueues `{job_id, tenant_id}` to `Q_AGENT` (existing queue) or new `Q_IMPORT` if cleaner. Returns 202 with `job_id`. `icrv-consumer` consumes the queue, processes 500 rows/batch, upserts contacts on `(tenant_id, email)`, writes progress to D1 + KV every batch. New endpoint `GET /v1/contacts/bulk-upload/{job_id}` returns job state. Frontend polls every 3s.
- **Excel import:** frontend-only via `xlsx` (SheetJS) library. Convert to CSV in browser, post to existing endpoint. No backend change.
- **Light mode:** `:root[data-theme="light"]` block in `index.css` mirroring the existing dark variables. Toggle in Header (sun/moon icon). Persists to `localStorage.icrv_theme`. First-load reads `prefers-color-scheme` if no saved value.
- **Lead Intelligence:** RULE-BASED scoring per the screenshot weights. Engagement 35%, Demographics 25%, Behavioral 20%, Tags 20%. Implement as a `recalculateLeadScore(contactId)` function in `packages/shared/src/scoring.ts`. Triggered: on every activity_log insert (worker handler), nightly cron (icrv-cron), and on-demand via "Recalculate All" button. NO ML, NO model. Pure SQL/code.
- **Regional Outreach:** Middle East focus. Add columns: `country_code`, `country_name_ar`, `region_tier`, `industry`, `industry_ar` to `contacts` table via migration. RTL via CSS `[dir="rtl"]` selectors. Simple JSON i18n at `frontend/src/i18n/{en,ar}.json` with a tiny `t(key)` helper. NO react-intl.
- **DKIM/SPF/DMARC verification:** worker fetches DNS via Cloudflare DNS-over-HTTPS at `https://cloudflare-dns.com/dns-query`, compares against expected, returns `{verified, found, expected}`. NEVER generate or store private keys; the user's email service holds those.
- **Tracking pixels:** open pixel at `GET /track/open?eid=...` returns 1×1 transparent PNG, writes event to `tracking_events`. Click rewriter: outbound links transformed to `/r?u={url_b64}&eid={event_id}`, redirect handler logs and 302s. Both routes are PUBLIC (no Access). Add `/track/*` and `/r` to the Access app's bypass list — write the exact dashboard instructions for the user to apply, then proceed assuming they will.
- **Templates library:** visual cards, basic HTML editor (textarea + sandboxed iframe preview), variable picker for `{{var_name}}`. NO drag-drop builder.
- **Webhooks:** `webhook_subscriptions` + `webhook_deliveries` tables. Fan-out from icrv-consumer with retry/backoff (3 retries, exponential 30s/2min/10min, then DLQ). HMAC signing of payloads with per-subscription secret.
- **WhatsApp Quotes:** stub page only. Title + "Coming soon" CTA. No backend.
- **Unsubscribe link infrastructure:** every email gets a footer with physical address (CAN-SPAM) + unsubscribe link. Link is `https://api.icrv.americanironus.com/u/{token}` where token is HMAC of `(contact_id, campaign_id, tenant_id, secret)`. Public endpoint, no auth, validates token, sets `consent_email=0`, displays a confirmation page. Add `/u/*` to Access bypass.

### Defaults applied if user skips Phase 0 questions
- Workspace: `American Iron LLC` / `https://americaniron1.com` / `America/New_York`
- CAN-SPAM physical address: `__PLACEHOLDER__` — render the compliance settings UI with a banner saying "ADD YOUR ADDRESS BEFORE SENDING REAL CAMPAIGNS — required by CAN-SPAM." Worker rejects sends with 422 if placeholder is still present. This is intentional friction so the user remembers to fix it.
- Daily sending limit: 500/day, 5 emails/sec throttle, warmup off
- Custom tracking domain: not set (use the api.icrv.americanironus.com default)
- Regional Outreach: Middle East per screenshot
- Lead Intelligence weights: Engagement 35% / Demographics 25% / Behavioral 20% / Tags 20%
- Visual style: keep the existing brand (Barlow Condensed display, Space Mono mono, accent #f59e0b amber). Do not redesign — refine.

### Hard constraints (never violate)
- Hardening invariants stay intact: CSP enforcing, HSTS, frame-ancestors none, Access gating /v1/*. New public endpoints (track, redirect, unsubscribe, csp-report, oauth callback, health) MUST be added to the Access app's path bypass list — document this for the user, then proceed assuming applied.
- All new schema changes are additive migrations in `migrations/NNNN_description.sql`. Do not edit `schema.sql` in place.
- Every new worker route preserves multi-tenancy (`tenant_id` filtering, no cross-tenant access).
- Every email send checks the kill switch FIRST; if active, drop to DLQ with `blocked_by_killswitch`.
- No new dependencies beyond: `xlsx`, `recharts` (verify if already installed), `@cloudflare/workers-types` (already there). Reject anything else; build it inline.
- Conventional Commits with phase prefix: `feat(v2.1): ...`, `feat(v2.2): ...` etc.
- Every commit passes `npm run typecheck` workspace-wide and `cd frontend && npm run build`.

## Operating rules — autonomous mode

1. **DO NOT ASK MID-FLIGHT.** The Phase 0 ask is your only chance to gather inputs. After that, every decision is yours. Document each non-obvious decision in the relevant commit message under `## Decisions`.
2. **STUB INSTEAD OF STOPPING.** If a feature is genuinely unbuildable in this session (e.g., a third-party API you can't reach, a setting that requires user IdP config), implement a stub that renders a "Coming soon — needs <X> setup" message with the exact instructions, commit it, move on. Note in the final report.
3. **SELF-VERIFY EACH PHASE — TWICE.** After preview deploy, run preview verification. If green, merge + deploy production. After production deploy, run LIVE production verification (against `https://icrv.americanironus.com` and `https://icrv-api.americanironus.com`). If preview fails: fix or stub before merging. If production fails after a green preview: see rule 4.
4. **AUTO-ROLLBACK ON PRODUCTION FAILURE.** If the live-URL smoke test on production fails after a phase's deploy, immediately:
   - `git revert --no-edit HEAD` (revert the merge commit)
   - `git push origin main`
   - Re-deploy each affected worker: `wrangler deploy` from each worker dir
   - Re-deploy frontend: `cd frontend && npm run build && wrangler pages deploy dist --project-name icrv-dashboard --branch main`
   - Re-run the live-URL smoke test to confirm rollback restored health
   - Document the rollback in `V2_BUILD_REPORT.md` § "Rollback events" with the failed-check output, the offending commit SHA, and your diagnosis of root cause
   - Mark that phase's failed feature as `FAILED` in the final matrix; OK to retry once more by re-implementing differently. After a second rollback on the same phase, mark it `FAILED` permanently and continue to next phase.
5. **PROCEED TO NEXT PHASE REGARDLESS.** Whether a phase ends in SHIPPED, STUBBED, or FAILED, immediately start the next phase. Do not stop. Do not ask. The user explicitly authorized live-deploy-and-continue. Forward progress over perfection.
6. **PRESERVE WORKING STATE ON GIT.** Every phase ends with `main` in a deployable state. If a merge conflicts, rebase, resolve, retry. If you cannot resolve a conflict in 15 minutes, abandon that phase's branch (delete it), commit a stub for the phase's features on a fresh branch off main, ship the stub, continue.
7. **WORKER COST AWARENESS.** Don't load-test. Verification curls (10–30 per phase) are fine.
8. **TIMEBOX UNKNOWNS.** 60 minutes max per feature without progress → stub and continue.

## Phase 0 — single batched ask

Print exactly this and wait for ONE reply. Apply defaults for anything skipped or omitted.

```
ICRV v2 mega-build kicks off now.

I'll execute Phases 1–5 fully autonomously after this single message.
Reply with whatever inputs you have. Type "build" alone to use all defaults.

URGENT inputs (improve Phase 1 outcomes):
1. The actual error from the bulk-upload timeout (paste exact text), or "unknown"
2. Sample failing CSV size (rows × MB), or "unknown"

DEFERRABLE inputs (defaults apply if skipped):
3. Workspace: company name | website | timezone
   Default: American Iron LLC | https://americaniron1.com | America/New_York
4. CAN-SPAM physical address (US legal requirement for marketing emails):
   street | city | state | zip | country
   Default: placeholder — Compliance Settings UI will WARN until set; sends
   will return 422 until set. (This is intentional friction.)
5. Daily sending limit | throttle: e.g. 500 | 5/sec
6. Custom tracking domain (or "skip"): e.g. track.americanironus.com
7. Regional Outreach focus: confirm "Middle East" or list ("EU,LATAM,APAC")
8. Lead Intelligence weight tweaks: e.g. "boost demographics to 35%" or "default"
9. Light mode: confirm "auto" (follows OS) or pick "always-light" / "always-dark-default"

Reply with any subset, or just "build".
After this, I will not ask further questions. I will:
  - Execute Phases 1–5 sequentially in one autonomous run
  - Stub any feature that can't ship cleanly, with the exact unblock steps
  - Self-test after each phase, fix what's broken, move on
  - Produce a final report at the end with what shipped, what stubbed, what failed
```

If user replies just "build" or with partial answers: apply defaults, log the answers received under `## Phase 0 inputs` in `HARDENING_REPORT.md`, proceed to Phase 1.

## Phase 1 — Urgent (target ~3-6h)

Branch: `feat/v2.1-urgent`

### 1A. Bulk upload timeout fix

Diagnose:
```bash
grep -nE "(bulk-upload|FormData|multipart|R2_UPLOADS|Q_AGENT)" workers/icrv-api/src/routes/contacts.ts workers/icrv-consumer/src/index.ts | head -40
```

Implement chunked-queue path. New `import_jobs` table:
```sql
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|processing|completed|failed
  total_rows INTEGER DEFAULT 0,
  processed_rows INTEGER DEFAULT 0,
  accepted INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0,
  errors_json TEXT,
  r2_key TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_import_jobs_tenant ON import_jobs(tenant_id, status, created_at DESC);
```

Migration file: `migrations/0001_import_jobs.sql`. Apply via `wrangler d1 execute icrv-db --remote --file=migrations/0001_import_jobs.sql`.

API handler `POST /v1/contacts/bulk-upload`: stage to R2, count rows by streaming (don't fully parse), insert job row, enqueue, return 202. Use a R2 multipart upload if file > 5MB.

Consumer worker change: read queue, fetch from R2 stream-style, parse 500 rows at a time, upsert contacts, write progress every batch, mark complete on EOF.

Endpoint `GET /v1/contacts/bulk-upload/{job_id}`: returns job_id row from D1 with progress. Frontend polls every 3s, shows progress bar with `processed_rows/total_rows`, on completion show accepted/rejected counts and download link for errors CSV (if any) generated from `errors_json` server-side.

Self-test after deploy:
```bash
seq 1 50000 | awk 'BEGIN{print "name,email,phone"} {printf "test%d,test%d@example.com,+1555%07d\n", $1, $1, $1}' > /tmp/big.csv
ls -la /tmp/big.csv  # should be ~2.5MB
# Manually upload via dashboard or via direct curl with auth cookie
# Confirm complete in <2 min
```

### 1B. Excel (.xlsx) import

`cd frontend && npm install --save xlsx@0.18`

Update bulk-upload modal:
- Accept attribute: `.csv,.xlsx,.xls,.tsv`
- On file change: branch by extension. CSV/TSV path unchanged. XLSX path: `XLSX.read(buffer)` → first sheet → `XLSX.utils.sheet_to_csv()` → treat as CSV from there.
- Preview table renders identically.
- File size cap stays 10 MB.

Self-test: upload an .xlsx via the same modal, observe identical preview + upload behavior to CSV.

### 1C. Light mode

Edit `frontend/src/index.css`. Add light theme variables:
```css
:root[data-theme="light"] {
  --bg-base: #ffffff;
  --bg-hover: #f5f5f5;
  --bg-active: #ebebeb;
  --text-primary: #0a0a0a;
  --text-secondary: #404040;
  --text-muted: #737373;
  --border-subtle: #e5e5e5;
  --border-default: #d4d4d4;
  --border-strong: #a3a3a3;
  --accent: #f59e0b;             /* keep brand */
  --accent-glow: rgba(245,158,11,0.1);
  --green: #16a34a;
  --red: #dc2626;
  --yellow: #ca8a04;
  --blue: #2563eb;
  --purple: #7c3aed;
  /* mirror every variable in the existing :root block */
}
```

Header.tsx: add a sun/moon toggle button. Click handler:
```tsx
const toggleTheme = () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('icrv_theme', next);
};
```

main.tsx boot:
```tsx
const saved = localStorage.getItem('icrv_theme');
const initial = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.setAttribute('data-theme', initial);
```

Audit hardcoded color literals:
```bash
grep -rnE "'#[0-9a-fA-F]{3,6}'|\"#[0-9a-fA-F]{3,6}\"" frontend/src/ | grep -v "var(--" | head -50
```
Replace inline literals with appropriate `var(--*)`. Estimate 30-50 fixes.

Self-test: walk every route in both themes via the CSP walk script you wrote in the prior session. No contrast failures (text >= 4.5:1 on background).

### 1D. Visual polish pass

- Empty states for: Contacts (no contacts), Campaigns (no campaigns), Activity (no events), Calls (no calls), AI Control (no agent runs). Use the existing `empty-state` class with an icon, title, one-sentence description, optional CTA.
- Loading states: every async button gets a spinner + disabled while pending.
- Hover + `:focus-visible` outline on every clickable element.
- Transitions: 150ms color, 200ms modal.
- Spacing: standardize on 4/8/12/16/24/32/48 scale.
- Button sizes: sm/md/lg consistency.

### 1E. Phase 1 acceptance + ship to LIVE

Standard flow per phase (apply this pattern to phases 2-5 too):

```bash
# 1. Local verify
cd ~/Documents/icrv
npm run typecheck && cd frontend && npm run build && cd ..

# 2. Preview deploy (branch-named)
cd workers/icrv-api && wrangler deploy --env preview && cd ../..  # if preview env exists, else just `wrangler deploy` to a -preview-named worker
cd workers/icrv-consumer && wrangler deploy --env preview && cd ../..
cd frontend && wrangler pages deploy dist --project-name icrv-dashboard --branch v2-phase1 && cd ..

# 3. Preview smoke test
PREVIEW_URL=$(cd frontend && wrangler pages deployment list --project-name icrv-dashboard | grep v2-phase1 | head -1 | awk '{print $NF}' || echo "https://v2-phase1.icrv-dashboard.pages.dev")
bash scripts/v2-verify.sh "$PREVIEW_URL" "https://icrv-api.americanironus.com" || { echo "PREVIEW FAILED — fix before merging"; exit 1; }

# 4. Merge to main
git switch main && git merge --no-ff feat/v2.1-urgent -m "feat(v2.1): bulk upload chunked queue + Excel + light mode + polish"
git push origin main

# 5. Deploy LIVE production
cd workers/icrv-api && wrangler deploy && cd ../..
cd workers/icrv-consumer && wrangler deploy && cd ../..
cd frontend && npm run build && wrangler pages deploy dist --project-name icrv-dashboard --branch main && cd ..

# 6. LIVE production smoke test (the one the user actually cares about)
sleep 30  # let Cloudflare propagation settle
bash scripts/v2-verify.sh "https://icrv.americanironus.com" "https://icrv-api.americanironus.com" || {
  echo "LIVE PRODUCTION FAILED — auto-rollback per Operating Rule 4"
  git revert --no-edit HEAD
  git push origin main
  cd workers/icrv-api && wrangler deploy && cd ../..
  cd workers/icrv-consumer && wrangler deploy && cd ../..
  cd frontend && npm run build && wrangler pages deploy dist --project-name icrv-dashboard --branch main && cd ..
  sleep 30
  bash scripts/v2-verify.sh "https://icrv.americanironus.com" "https://icrv-api.americanironus.com" || echo "ROLLBACK ALSO FAILED — investigate"
  echo "Phase 1 marked FAILED. Continuing to Phase 2."
}
echo "Phase 1 LIVE ✓ — proceeding to Phase 2 immediately"
```

Apply the same six-step pattern to Phases 2-5. The only differences are: branch name, commit message, and which workers to redeploy (only redeploy workers whose code changed in that phase).

## Phase 2 — Settings pages (target ~3-5h)

Branch: `feat/v2.2-settings`

`tenant_settings` table (migration 0002):
```sql
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id TEXT PRIMARY KEY,
  workspace_json TEXT NOT NULL DEFAULT '{}',
  compliance_json TEXT NOT NULL DEFAULT '{}',
  sending_json TEXT NOT NULL DEFAULT '{}',
  tracking_json TEXT NOT NULL DEFAULT '{}',
  authentication_json TEXT NOT NULL DEFAULT '{}',
  personalization_json TEXT NOT NULL DEFAULT '{}',
  bounce_json TEXT NOT NULL DEFAULT '{}',
  api_webhooks_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Refactor `/settings` to a sub-routed page:
- `/settings/general` (workspace + timezone)
- `/settings/compliance` (CAN-SPAM address + unsubscribe behavior)
- `/settings/sending` (daily limit + throttle + warmup)

Worker endpoints:
- `GET /v1/settings/{section}` → returns settings_json subset
- `PUT /v1/settings/{section}` → upsert
- `tenant_id` from auth context

Email worker change: append CAN-SPAM footer (physical address + unsubscribe link) to every email automatically. If `compliance.physical_address.street` is `__PLACEHOLDER__`, the worker returns 422 with a clear error message — the dashboard shows that error in the activity_log row.

Daily limit enforcement in icrv-email: before send, query `activity_log WHERE type='email_sent' AND tenant_id=? AND occurred_at > date('now','start of day')`. If count >= limit, requeue with delay until next midnight UTC. Throttle via token bucket in `KV_RATE`.

Unsubscribe endpoint `GET /u/{token}` (PUBLIC, add to Access bypass). Validates HMAC, displays a styled confirmation page with branded look, sets `consent_email=0` in D1.

Phase 2 acceptance:
- Walk all three settings pages in both themes, save changes, verify persistence
- Send a test campaign, verify the footer is appended with correct address + unsubscribe link
- Click the unsubscribe link, verify the contact's `consent_email` flips to 0
- Try to send to that contact, verify it's blocked

## Phase 3 — Email Authentication + Tracking & Analytics (target ~4-6h)

Branch: `feat/v2.3-auth-tracking`

### 3A. DKIM/SPF/DMARC settings UI + verifier

`/settings/authentication`:
- Domain input
- DKIM Selector input (default `icrv`)
- For each of DKIM/SPF/DMARC: status badge, expected DNS record textarea, Copy button, Check button

Worker endpoints:
- `POST /v1/auth/check-dkim` body `{domain, selector}` → fetches DNS via DNS-over-HTTPS, returns `{verified, found, expected}`
- Same pattern for SPF and DMARC

DKIM record: generate or read tenant's keypair from KV_CONFIG. If absent, generate via `crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:[1,0,1], hash:'SHA-256'}, true, ['sign','verify'])`, store private key encrypted with MASTER_KEK, expose public key in the DNS record string.

DMARC default record: `_dmarc.{domain} TXT v=DMARC1; p=quarantine; rua=mailto:dmarc@{domain}; ruf=mailto:dmarc@{domain}; fo=1`

SPF default record: `v=spf1 include:_spf.google.com include:icrv-email.americanironadmin.workers.dev ~all`

### 3B. Tracking & Analytics settings UI

`/settings/tracking`:
- Open Tracking toggle (default ON)
- Click Tracking toggle (default ON)
- Custom tracking domain input
- UTM parameter prefix / medium / campaign prefix
- Enable Google Analytics integration toggle

### 3C. Tracking infrastructure

`tracking_events` table (migration 0003):
```sql
CREATE TABLE IF NOT EXISTS tracking_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  contact_id TEXT,
  campaign_id TEXT,
  type TEXT NOT NULL,  -- open|click|bounce|unsubscribe|complaint
  url TEXT,
  ip TEXT,
  user_agent TEXT,
  occurred_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_tracking_tenant_type ON tracking_events(tenant_id, type, occurred_at DESC);
CREATE INDEX idx_tracking_campaign ON tracking_events(campaign_id, type);
```

Worker endpoints (PUBLIC, add to Access bypass):
- `GET /track/open?eid=...` — decodes eid (HMAC-signed `{tenant_id, campaign_id, contact_id, sent_at}`), inserts open event, returns 1×1 transparent PNG with `Cache-Control: no-store`
- `GET /r?u=...&eid=...` — decodes, inserts click event, 302s to decoded url

Email worker change: when sending, inject `<img src="https://api.icrv.americanironus.com/track/open?eid={eid}" width="1" height="1" alt="" />` at end of body; rewrite all `<a href>` to redirect URLs.

UTM auto-append: if tenant tracking settings have UTMs configured AND the destination URL doesn't already have utm_*, append them.

### 3D. Phase 3 acceptance

- Walk authentication and tracking settings pages in both themes
- Paste a real DKIM TXT record, verify Check button shows "Verified" if it actually exists in DNS
- Send a test campaign with a link, open the email, click the link, verify both events land in `tracking_events`

## Phase 4 — Lead Intelligence + Analytics (target ~4-6h)

Branch: `feat/v2.4-intelligence`

### 4A. Scoring engine

`packages/shared/src/scoring.ts`:
```typescript
export function calculateLeadScore(contact: Contact, activity: ActivityCounts, demographics: Demographics, tags: string[]): LeadScore {
  // Engagement (35%)
  const opens = Math.min(activity.opens * 5, 15);
  const clicks = Math.min(activity.clicks * 8, 20);
  const replies = Math.min(activity.replies * 10, 15);
  const engagement = (opens + clicks + replies) / 50 * 35;

  // Demographics (25%)
  const countryBoost = TIER1_COUNTRIES.includes(demographics.country) ? 15
                     : TIER2_COUNTRIES.includes(demographics.country) ? 8 : 0;
  const industryBoost = TIER1_INDUSTRIES.includes(demographics.industry) ? 10
                      : TIER2_INDUSTRIES.includes(demographics.industry) ? 8 : 0;
  const demoScore = (countryBoost + industryBoost) / 25 * 25;

  // Behavioral (20%)
  const visits = Math.min(activity.website_visits * 3, 12);
  const submissions = Math.min(activity.form_submissions * 6, 12);
  const recentBoost = activity.last_activity_within_7d ? 5 : 0;
  const behavioral = (visits + submissions + recentBoost) / 29 * 20;

  // Tags (20%)
  const tagBonuses = { investor: 10, buyer: 10, buyers: 10, dealer: 8, vip: 7, partner: 5, partners: 5 };
  const tagScore = Math.min(tags.reduce((sum, t) => sum + (tagBonuses[t.toLowerCase()] || 0), 0), 40) / 40 * 20;

  const total = Math.round(engagement + demoScore + behavioral + tagScore);
  const category = total >= 80 ? 'hot' : total >= 50 ? 'warm' : 'cold';
  return { score: total, category, engagement, demographic: demoScore, behavioral, tag: tagScore };
}

const TIER1_COUNTRIES = ['SA', 'AE', 'KW'];
const TIER2_COUNTRIES = ['EG', 'BH', 'OM', 'QA'];
const TIER1_INDUSTRIES = ['construction', 'oil_gas'];
const TIER2_INDUSTRIES = ['heavy_equipment', 'equipment_dealers'];
```

`lead_scores` table (migration 0004):
```sql
CREATE TABLE IF NOT EXISTS lead_scores (
  contact_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  category TEXT NOT NULL,
  engagement_score REAL,
  demographic_score REAL,
  behavioral_score REAL,
  tag_score REAL,
  last_calculated TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_lead_scores_tenant_score ON lead_scores(tenant_id, score DESC);
CREATE INDEX idx_lead_scores_category ON lead_scores(tenant_id, category);
```

Recalculate triggers:
- On every `activity_log` insert in icrv-consumer: recalc the affected contact
- Nightly cron in icrv-cron: full sweep, batched 1000/run
- On-demand: `POST /v1/leads/recalculate-all` triggers an enqueue of all contacts

UI:
- `/leads/intelligence` — three count tiles (hot/warm/cold), top hot leads, top warm leads, scoring logic breakdown card
- `/leads/ranked` — full table sorted by score DESC, filter chips (All/Hot/Warm/Cold), engagement bar visualization, tags column, click row → contact details

### 4B. Analytics dashboard

`/analytics`:
- Period selector (7/30/90/All)
- Six metric cards (Total Sent, Avg Open, Avg Click, Delivery, Total Bounced, Unsubscribed)
- Export button → CSV
- Campaign Performance bar chart (recharts BarChart, last N campaigns)
- Email Status Breakdown donut (recharts PieChart)
- All Campaign Results table
- Opens by Hour of Day (recharts BarChart, 24 buckets)
- Top Performing Campaigns (sorted by open rate)

If recharts isn't installed: `cd frontend && npm install --save recharts`. Otherwise use existing.

API endpoints:
- `GET /v1/analytics/overview?period=7|30|90|all` — returns the six metrics
- `GET /v1/analytics/campaigns?period=...` — array of campaigns with their stats
- `GET /v1/analytics/opens-by-hour?period=...` — 24-bucket array

### 4C. Phase 4 acceptance

- Walk both intelligence pages and analytics in both themes
- Confirm scores updated in D1: `wrangler d1 execute icrv-db --remote --command="SELECT category, COUNT(*) FROM lead_scores GROUP BY category"`
- Send a real test campaign, wait 2 minutes for analytics to populate, see the metric cards reflect it

## Phase 5 — Content (target ~6-10h)

Branch: `feat/v2.5-content`

This is the biggest phase. Land features in this order. Stub if any single feature blocks for >60min.

### 5A. Templates library

`/templates`:
- Visual cards with iframe preview (sandboxed: `<iframe sandbox srcDoc={template_html}>`)
- + New Template modal: name input, channel dropdown (email|whatsapp|voice), HTML editor (textarea), preview iframe, variable picker (clicks insert `{{var_name}}` at cursor)
- Search + tag filter
- Tags free-form

`templates` table already exists. Just build the UI + GET/POST/PUT/DELETE worker routes.

### 5B. Personalization Engine

`/settings/personalization`:
- Custom variables table (name, default value, fallback toggle)
- + Add Variable modal
- Variables stored in `tenant_settings.personalization_json`
- `contacts.custom_fields_json` column (migration 0005)

Email worker change: substitution at send time. `{{var_name}}` looks up:
1. `contacts.custom_fields_json[var_name]`
2. `tenant_settings.personalization_json[var_name].default_value` (if fallback enabled)
3. Empty string (if neither)

### 5C. Bounce & Complaint Handling

`/settings/bounces`:
- Hard bounce threshold (default 3)
- Soft bounce retry count (default 3)
- Auto-unsubscribe on complaints toggle
- Bounce notification email
- Clean Bounced Contacts button → bulk update `consent_email=0` for any contact with `bounce_count >= threshold`

`contacts.bounce_count`, `contacts.complaint_count` columns (migration 0006).

icrv-hooks worker: parse Gmail bounce webhooks (likely already partially wired), increment bounce_count, take action per settings.

### 5D. API & Webhooks

`/settings/api-webhooks`:
- API Key (sk_*) — generated on first visit, stored hashed in D1
- Webhook URL inputs for each event type (email_sent, opened, clicked, bounced, unsubscribed, call_completed)
- Send Test Event button per webhook → fires synthetic payload
- Recent Webhook Deliveries table (last 50)

`webhook_subscriptions` + `webhook_deliveries` tables (migration 0007).

icrv-consumer fan-out: after each successful event, enqueue webhook deliveries. icrv-webhooks worker (or icrv-consumer if cleaner) sends with HMAC signature header, retries 3x exponential, DLQ after.

### 5E. Regional Outreach

`/regional`:
- Country tiles (Saudi, UAE, Kuwait, Egypt, Bahrain, Oman, Qatar, "All Regions", "Other ME")
- Industry filter chips
- Filtered leads table
- English/Arabic toggle (RTL via `dir="rtl"` on `<html>` or container)

`contacts.country_code`, `country_name_ar`, `region_tier`, `industry`, `industry_ar` (migration 0008).

i18n: `frontend/src/i18n/en.json`, `ar.json`. Tiny `t(key)` helper. Toggle stored in localStorage.

### 5F. WhatsApp Quotes stub

`/whatsapp/quotes`:
- Title "WhatsApp Quotes"
- Empty-state card: "Coming soon. Reach out to define what this should do."
- No backend.

### 5G. Phase 5 acceptance

- Create a template, use a custom variable in it, run a campaign with it, verify substitution in delivered email
- Trigger a test webhook, verify delivery row in webhook_deliveries
- Walk Regional Outreach in both EN and AR
- Verify the WhatsApp Quotes stub renders cleanly in both themes

## Verification recipe — save as `scripts/v2-verify.sh`, run after preview AND after live production

This script is invoked twice per phase: once against the preview URL (gate before merge), once against `https://icrv.americanironus.com` after production deploy (gate for rollback).

```bash
#!/usr/bin/env bash
set -e
HOST="${1:?usage: $0 <pages-url> <api-url>}"
API="${2:?api url}"

section() { echo; echo "=== $1 ==="; }

section "Hardening invariants"
curl -sI "$HOST/contacts" | grep -iE "content-security-policy|strict-transport|x-frame" | wc -l   # expect 3
curl -s -o /dev/null -w "%{http_code}\n" "$API/v1/contacts"                                       # expect 302 (Access)
curl -s -o /dev/null -w "%{http_code}\n" "$API/health"                                            # expect 200 (public)

section "Phase 1: Upload"
curl -s -o /dev/null -w "%{http_code}\n" "$API/v1/contacts/bulk-upload"                           # 401 or 405 (Access gating)

section "Phase 1: Light mode pixels"
curl -s "$HOST/" | grep -c "data-theme"                                                           # expect 1+

section "Phase 3: Tracking pixel public"
curl -sI "$API/track/open?eid=test" | head -1                                                     # 200 or 400 (depending on eid validation)

section "Phase 3: DKIM verifier endpoint"
curl -s -o /dev/null -w "%{http_code}\n" "$API/v1/auth/check-dkim"                                # 401 (Access gating)

section "Phase 4: Lead scores written"
wrangler d1 execute icrv-db --remote --command="SELECT COUNT(*) c FROM lead_scores"               # >0 after Phase 4

section "Phase 5: Templates table populated"
wrangler d1 execute icrv-db --remote --command="SELECT COUNT(*) c FROM templates"                 # >0

section "TypeCheck + Build"
npm run typecheck >/dev/null && echo "typecheck ✓"
( cd frontend && npm run build >/dev/null ) && echo "frontend build ✓"
```

## Final report (always produce)

After all phases (or all that you could ship), write `V2_BUILD_REPORT.md` at repo root with:

```markdown
# ICRV v2 mega-build — final report

## Session
- Started: <timestamp>
- Ended: <timestamp>
- Duration: <hours>

## Status matrix

| Phase | Feature | Status | Commit |
|---|---|---|---|
| 1 | Bulk upload chunked queue | <SHIPPED|STUBBED|FAILED> | <sha> |
| 1 | Excel import | ... | ... |
| 1 | Light mode | ... | ... |
| 1 | Visual polish | ... | ... |
| 2 | General settings | ... | ... |
| 2 | Compliance settings | ... | ... |
| 2 | Sending limits | ... | ... |
| 3 | DKIM/SPF/DMARC verifier | ... | ... |
| 3 | Open tracking | ... | ... |
| 3 | Click tracking | ... | ... |
| 3 | UTM auto-append | ... | ... |
| 4 | Lead scoring engine | ... | ... |
| 4 | Lead intelligence UI | ... | ... |
| 4 | All leads ranked | ... | ... |
| 4 | Analytics dashboard | ... | ... |
| 5 | Templates library | ... | ... |
| 5 | Personalization engine | ... | ... |
| 5 | Bounce handling | ... | ... |
| 5 | API & Webhooks | ... | ... |
| 5 | Regional Outreach (EN+AR) | ... | ... |
| 5 | WhatsApp Quotes stub | ... | ... |

## What was stubbed and why
<for each STUBBED row: feature name, what's stubbed, exact unblock steps the user needs>

## What failed and why
<for each FAILED row: failure mode, partial commit hash if any, unblock steps>

## Manual steps still on the user (consolidated)
1. R2 lifecycle rule for d1-backups (~30 sec dashboard)
2. R2 lifecycle rule for imports/ (~30 sec, suggest 7-day retention)
3. CAN-SPAM physical address (if placeholder still): /settings/compliance
4. Cost caps: ElevenLabs, RingCentral, Anthropic, Cloudflare (5 min)
5. Cloudflare Access path bypasses for: /track/*, /r, /u/*, /csp-report, /health, /oauth/google/callback
6. DNS records for tracking domain (if custom): track.americanironus.com → CNAME api.icrv.americanironus.com
7. <any phase-specific manual steps>

## Backlog (deferred features for future)
<anything WhatsApp Quotes-style that needs spec before implementation>

## Recommended next 3 actions
1. <highest-leverage>
2. <next>
3. <next>
```

Commit:
```bash
git add V2_BUILD_REPORT.md
git commit -m "docs(v2): final build report — <PASS_COUNT> shipped, <STUB_COUNT> stubbed, <FAIL_COUNT> failed"
git push origin main
```

Print the final report's status matrix to the user as your last message.

## Reminder

You have permission to make every architectural decision. You have permission to defer/stub anything that gets in the way. You DO NOT have permission to ask the user a single follow-up question between Phase 0 and the final report. The user is unavailable. Run.
