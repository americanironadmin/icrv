# ICRV v2 mega-build — final report

## Session
- Started:  2026-05-06 23:00 UTC
- Ended:    2026-05-06 23:55 UTC (compressed; one autonomous run)
- Mode:     Fully autonomous (Operating rules per CC-PROMPT-icrv-v2-mega.md)
- Operator: adam@americaniron1.com / admin / tenant_americaniron_001
- Final main HEAD: see `git log -1`

## Phase 0 inputs (defaults applied — user said "build")

| Input | Default Applied |
|---|---|
| Bulk-upload error symptom | unknown — diagnosed from code |
| Workspace | American Iron LLC / https://americaniron1.com / America/New_York |
| CAN-SPAM physical address | `__PLACEHOLDER__` (UI warns, sends 422 until set) |
| Daily sending limit / throttle | 500/day / 5/sec |
| Custom tracking domain | not set — uses `icrv-api.americanironus.com` |
| Regional Outreach focus | Middle East (SA, AE, KW, EG, BH, OM, QA) |
| Lead Intelligence weights | Engagement 35% / Demographics 25% / Behavioral 20% / Tags 20% |
| Light mode | auto (prefers-color-scheme), persisted to localStorage |

## Pre-existing state (Phase -1 discovery — see git log of this file for original)

Existing infra was reused (NOT recreated): KV namespaces, R2 buckets, D1 db, secrets per worker.
New resource added: Cloudflare Queue `icrv-imports` (Phase 1A).
New secrets added: `EMAIL_TRACK_KEY` on icrv-api + icrv-email (Phase 3).

## Status matrix

| Phase | Feature | Status | Branch / Commit |
|---|---|---|---|
| 1 | Bulk upload chunked queue           | SHIPPED | feat/v2.1-urgent / e888a3a |
| 1 | Excel (.xlsx) import                | SHIPPED | feat/v2.1-urgent |
| 1 | Light mode (auto + toggle)          | SHIPPED | feat/v2.1-urgent |
| 1 | Visual polish pass                  | SHIPPED | feat/v2.1-urgent |
| 2 | Workspace settings (`/general`)     | SHIPPED | feat/v2.2-settings / d622c79 |
| 2 | Compliance settings (`/compliance`) | SHIPPED | feat/v2.2-settings |
| 2 | Sending limits (`/sending`)         | SHIPPED | feat/v2.2-settings |
| 2 | CAN-SPAM footer + 422 gate          | SHIPPED | feat/v2.2-settings |
| 2 | Public `/u/:token` unsubscribe      | SHIPPED | feat/v2.2-settings (NEEDS Access bypass) |
| 3 | DKIM verifier (DoH)                 | SHIPPED | feat/v2.3-auth-tracking / e279ff4 |
| 3 | SPF verifier                        | SHIPPED | feat/v2.3-auth-tracking |
| 3 | DMARC verifier                      | SHIPPED | feat/v2.3-auth-tracking |
| 3 | Open tracking (HMAC-signed eid)     | SHIPPED | feat/v2.3-auth-tracking (NEEDS Access bypass) |
| 3 | Click tracking + redirect           | SHIPPED | feat/v2.3-auth-tracking (NEEDS Access bypass) |
| 3 | UTM auto-append                     | SHIPPED | feat/v2.3-auth-tracking |
| 4 | Lead scoring engine (rule-based)    | SHIPPED | feat/v2.4-intelligence / 8aa8456 |
| 4 | Lead intelligence dashboard         | SHIPPED | feat/v2.4-intelligence |
| 4 | All-leads ranked table              | SHIPPED | feat/v2.4-intelligence |
| 4 | Analytics dashboard (recharts)      | SHIPPED | feat/v2.4-intelligence |
| 4 | Cron nightly recalc sweep           | SHIPPED | feat/v2.4-intelligence |
| 5 | Templates library + editor + tags   | SHIPPED | feat/v2.5-content / 59fe9f0 |
| 5 | Personalization engine (subst.)     | SHIPPED | feat/v2.5-content |
| 5 | Bounce handling (clean endpoint)    | PARTIAL | feat/v2.5-content (operator-driven; auto-bump from Gmail DSN deferred) |
| 5 | API key generation                  | SHIPPED | feat/v2.5-content |
| 5 | Webhook subscriptions UI            | SHIPPED | feat/v2.5-content (delivery worker deferred — see below) |
| 5 | Regional Outreach (EN+AR + RTL)     | SHIPPED | feat/v2.5-content |
| 5 | WhatsApp Quotes stub                | SHIPPED | feat/v2.5-content |

## What was stubbed and why

### Webhook delivery worker (Phase 5 partial)
**Stubbed:** `webhook_subscriptions` and `webhook_deliveries` tables exist;
admin UI at `/settings/api-webhooks` lists/adds/removes subscriptions. The
fan-out worker that signs HMAC payloads, retries with exponential backoff,
and DLQs after 3 attempts is NOT implemented.
**Unblock:** add a producer in icrv-consumer that, on every successful
agent_action, enqueues a `webhook_delivery` job into a new `icrv-webhooks`
queue. New consumer worker reads, fetches subscription URL+secret, POSTs
with `X-ICRV-Signature: sha256=…`, on non-2xx writes `next_retry_at` per
30s/2m/10m schedule and re-enqueues; after 3 attempts marks `dlq`.

### Auto bounce-count bump (Phase 5 partial)
**Stubbed:** `contacts.bounce_count` exists and `/v1/bounces/clean` revokes
consent for any contact whose count >= threshold. But nothing currently
*increments* bounce_count — Gmail returns SMTP errors but we don't parse
DSN messages out of the inbox.
**Unblock:** in icrv-consumer's `processGmailPush`, detect `mailer-daemon`
sender + `X-Failed-Recipients` header, look up the recipient's contact_id,
`UPDATE contacts SET bounce_count = bounce_count + 1`. Soft-bounce vs hard
classification by SMTP code prefix (5xx hard, 4xx soft).

### WhatsApp Quotes (Phase 5 by design)
**Stubbed:** `/whatsapp/quotes` renders a "Coming soon" card; no backend.
**Unblock:** spec the conversation shape (price-list lookup, quote-id
ingestion, follow-up automation) before implementation.

## What failed and why
None — every phase's preview verification was green and the live deploy
shipped without rollback.

## Manual steps still on the user (consolidated)

1. **Cloudflare Access bypass list** — add the following paths to the Access
   app for `icrv-api.americanironus.com` so unauthenticated callers can hit
   them. Without this, unsubscribe links and tracking pixels return 401.
   - `/u/*`           (CAN-SPAM unsubscribe)
   - `/track/*`       (open pixel)
   - `/r`             (click redirect)
   - already bypassed: `/health`, `/csp-report`, `/oauth/google/callback`

2. **CAN-SPAM physical address** — `/settings/compliance` will show a red
   banner until set. Until you set it, every email send returns 422
   (`compliance_address_missing`). This is intentional friction.

3. **R2 lifecycle** for `icrv-uploads/imports/` — suggest 7-day retention
   to avoid hoarding bulk-upload CSVs.

4. **DNS for tracking domain (optional)** — if you want a branded tracking
   host like `track.americanironus.com`, set up a CNAME pointing at
   `icrv-api.americanironus.com`, then update `/settings/tracking →
   custom_domain`. The icrv-email worker honours this when injecting
   tracking URLs.

5. **DKIM key generation** — the v2 build doesn't auto-generate the DKIM
   keypair (deferred). Use Google Workspace's auto-DKIM or your DNS
   provider's, paste the resulting public-key `p=…` into the expected
   record on `/settings/authentication`, then click Check.

6. **Cost caps** (per HARDENING_REPORT recommendation): ElevenLabs,
   RingCentral, Anthropic, Cloudflare account-level caps.

## Backlog (deferred features for future)

- **Webhook delivery worker** with HMAC + retry + DLQ (see Phase 5 partial above).
- **Gmail DSN parser** for auto-bounce counting (see Phase 5 partial above).
- **Templates: drag-drop builder** — the current editor is textarea +
  iframe preview, intentional per build prompt's "no drag-drop" decision.
- **WhatsApp Quotes** end-to-end implementation.
- **DKIM auto-keygen** + publish encrypted private key to KV.
- **Code-split frontend bundle** (recharts + xlsx push the main bundle to
  ~875 KB; current behaviour is OK but could be lazy-loaded).
- **Personalization variables CRUD** in `/settings/personalization` (panel
  is currently `Coming soon`; substitution backend already wired and
  ready).

## Recommended next 3 actions

1. **Add the four Cloudflare Access bypass paths.** Until done, unsubscribe
   links in delivered emails will not work — every recipient who clicks
   them sees the Access login screen.
2. **Set the CAN-SPAM physical address.** Sends are blocked until done.
   Use `/settings/compliance` in the dashboard.
3. **Trigger lead-score recalculation manually** via the "Recalculate All"
   button on `/leads` so the dashboards have data before the nightly cron
   runs at 03:00 UTC.

## Verification one-liners

```bash
# Smoke test against production
bash scripts/v2-verify.sh https://icrv.americanironus.com https://icrv-api.americanironus.com --skip-build

# Inspect tracking events (after a test send + click)
wrangler d1 execute icrv-db --remote --command="SELECT type, COUNT(*) FROM tracking_events GROUP BY type"

# Re-score one tenant
wrangler d1 execute icrv-db --remote --command="SELECT category, COUNT(*) FROM lead_scores GROUP BY category"

# Inspect import jobs
wrangler d1 execute icrv-db --remote --command="SELECT status, COUNT(*) FROM import_jobs GROUP BY status"

# Re-apply migrations on a fresh tenant if needed
wrangler d1 execute icrv-db --remote --file=migrations/0001_import_jobs.sql
wrangler d1 execute icrv-db --remote --file=migrations/0002_tenant_settings.sql
wrangler d1 execute icrv-db --remote --file=migrations/0003_tracking_events.sql
wrangler d1 execute icrv-db --remote --file=migrations/0004_lead_scores.sql
wrangler d1 execute icrv-db --remote --file=migrations/0005_phase5.sql
```

## Rollback events
None.

## Architecture decisions (single-line each, quick reference)

- Bulk upload: chunked-queue via new `icrv-imports` queue + dedicated
  `import_jobs` D1 table (kept legacy `upload_jobs` untouched).
- Light mode: `:root[data-theme="light"]` CSS-var overrides; toggle in
  Header; first-load reads OS preference.
- Settings: section JSON blobs in `tenant_settings` (workspace, compliance,
  sending, tracking, authentication, personalization, bounce, api_webhooks).
- Public endpoints: `/u/:token`, `/track/open`, `/r` mounted on icrv-api
  outside `/v1`; HMAC tokens with EMAIL_TRACK_KEY + UUID-token fallback for
  unsubscribe.
- Tracking: open pixel = HMAC-signed eid; click = `/r?u={b64url}&eid={hmac}`
  with UTM auto-append.
- Lead scoring: pure function in `@icrv/shared/scoring`; recalc inline on
  /v1/leads/recalculate-all + nightly via icrv-cron.
- Analytics: recharts only (no D3 / no plotly); period 7|30|90|all driven
  by SQL `datetime('now','-N days')` cutoffs.
- Templates: textarea HTML editor + sandboxed iframe preview; no drag-drop.
- Regional Outreach: minimal in-house i18n (no react-intl), `dir="rtl"`
  on container, locale persisted to localStorage.
- WhatsApp Quotes: stub page, intentional.
