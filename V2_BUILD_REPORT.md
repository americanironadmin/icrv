# ICRV v2 mega-build — final report

## Session
- Started: 2026-05-06 23:00 UTC
- Mode: Fully autonomous (Operating rules per CC-PROMPT-icrv-v2-mega.md)
- Operator: adam@americaniron1.com / admin / tenant_americaniron_001

## Phase 0 inputs
User invoked autonomous run with no per-input answers — all defaults applied.

| Input | Default Applied |
|---|---|
| Bulk-upload error symptom | unknown — diagnose from code only |
| Sample failing CSV size | unknown |
| Workspace | American Iron LLC / https://americaniron1.com / America/New_York |
| CAN-SPAM physical address | `__PLACEHOLDER__` (UI warns, sends 422 until set) |
| Daily sending limit / throttle | 500/day / 5/sec |
| Custom tracking domain | not set — use `icrv-api.americanironus.com` |
| Regional Outreach focus | Middle East (SA, AE, KW, EG, BH, OM, QA) |
| Lead Intelligence weights | Engagement 35% / Demographics 25% / Behavioral 20% / Tags 20% |
| Light mode | auto (prefers-color-scheme), persisted to localStorage |

## Pre-existing state (Phase -1 discovery)

### KV namespaces (DO NOT recreate)

| Binding | Title | ID |
|---|---|---|
| KV_CONFIG | ICRV_KV_CONFIG | ab921928cea14fbe9756f9a67ae3c1d3 |
| KV_OAUTH | ICRV_KV_OAUTH | 5e605b3a83994ee5b78b084d6b561d0b |
| KV_RATE | ICRV_KV_RATE | daf3f5efc06346a1a383150ab1de37da |
| KV_IDEMP | ICRV_KV_IDEMP | 878fe6fdfa844b9d96df8017ac39ee63 |
| KV_TRACK | ICRV_KV_TRACK | 7926181a73194dd2a2e14307cb7d4a27 |
| KV_REVOKED | KV_REVOKED | 09db5d58b02948a4ad5d60536dfbab01 |
| KV_JWKS | KV_JWKS | 42576af6e50642f492fc1cc03c5f1e7b |

### R2 buckets (DO NOT recreate)
- `icrv-uploads` (R2_UPLOADS) — bulk-upload staging
- `icrv-media` (R2_MEDIA)
- `icrv-exports` (R2_EXPORTS) — D1 backups land here
- `icrv-transcripts` (R2_TRANSCRIPTS)
- `icrv-evidence` (R2_EVIDENCE)

### D1 (`icrv-db`, fdf24661-6675-4570-b1b7-f2b672cad4bf) — existing tables
agent_actions, agent_controls, agent_runs, api_credentials, audit_logs, call_logs,
call_transcripts, campaign_enrollments, campaign_steps, campaigns, consents,
contact_tags, contacts, message_events, messages, oauth_tokens, suppressions,
templates, tenants, unsubscribes, **upload_jobs**, users, voicemails, webhooks_received

### Secrets already set per worker (per `wrangler secret list`)
- icrv-api: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JWT_SIGNING_KEY, MASTER_KEK
- icrv-agent: ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MASTER_KEK
- icrv-email: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MASTER_KEK
- icrv-whatsapp: MASTER_KEK, WA_APP_SECRET, WA_PHONE_NUMBER_ID, WA_VERIFY_TOKEN, WA_WABA_ID
- icrv-voice: ANTHROPIC_API_KEY, EL_API_KEY, EL_LLM_SHARED_SECRET, MASTER_KEK, RC_JWT
- icrv-hooks: EL_WEBHOOK_SECRET, MASTER_KEK, RC_WEBHOOK_TOKEN, WA_ACCESS_TOKEN, WA_APP_SECRET, WA_PHONE_NUMBER_ID
- icrv-consumer: ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MASTER_KEK, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_WABA_ID
- icrv-cron: CF_API_TOKEN

### Custom domains live (DO NOT reconfigure)
- `https://icrv.americanironus.com` — Pages dashboard (Access protected)
- `https://icrv-api.americanironus.com` — icrv-api worker (Access protected)
- Cloudflare Access in OAuth 2.0 Protected Resource mode (per memory) — service-token headers no longer work; smoke tests must hit unique-hash Pages URLs or be tolerant of 401 on bare-host probes.

### Cron schedule (icrv-cron)
crons = `* * * * *`, `*/5 * * * *`, `0 * * * *`, `0 3 * * *` (D1 backup at 03:00 UTC)

### HARDENING_REPORT closure status
All C, H, M items closed (table verified). L1 deferred. CSP enforcing flipped 2026-05-04.
Make-it-real verification 2026-05-06: Email PASS; Voice/WhatsApp deferred (RC trial / Meta template approval).

### Phase 1A important discovery
- `upload_jobs` table EXISTS with columns: id, tenant_id, user_id, source_uri, status, total_rows, processed, accepted, rejected, errors_json, created_at, updated_at, completed_at
- Existing `POST /v1/contacts/bulk-upload` parses INLINE (workers/icrv-api/src/routes/contacts.ts:249) — this is the bug source. Stages to R2, parses inline up to 50k rows, runs synchronous D1 inserts.
- Will migrate to chunked-queue: keep `upload_jobs` table (extend with R2 key), introduce queue producer in api → consumer processes batches.
- icrv-consumer ALREADY consumes `icrv-email-in`, `icrv-retry`, `icrv-dlq` (workers/icrv-consumer/src/index.ts) — extend to handle new `import_job` type messages on a new `Q_IMPORT` queue OR reuse `Q_AGENT`.

### Frontend state
- React 18 + Vite + react-router 6
- Pages: Dashboard, Contacts, Campaigns, ActivityLogs, AIControlPanel, CallMonitoring, Settings, NotFound
- papaparse already installed (CSV parser); xlsx and recharts NOT installed yet
- index.css drives dark theme via CSS vars on `:root`

### Dependencies decided
- xlsx@0.18 (Phase 1B) — frontend-only Excel→CSV
- recharts (Phase 4B) — analytics charts

## Status matrix

| Phase | Feature | Status | Commit |
|---|---|---|---|
| 1 | Bulk upload chunked queue | PENDING | — |
| 1 | Excel import | PENDING | — |
| 1 | Light mode | PENDING | — |
| 1 | Visual polish | PENDING | — |
| 2 | General settings | PENDING | — |
| 2 | Compliance settings | PENDING | — |
| 2 | Sending limits | PENDING | — |
| 2 | Unsubscribe endpoint | PENDING | — |
| 3 | DKIM/SPF/DMARC verifier | PENDING | — |
| 3 | Open tracking | PENDING | — |
| 3 | Click tracking | PENDING | — |
| 3 | UTM auto-append | PENDING | — |
| 4 | Lead scoring engine | PENDING | — |
| 4 | Lead intelligence UI | PENDING | — |
| 4 | All leads ranked | PENDING | — |
| 4 | Analytics dashboard | PENDING | — |
| 5 | Templates library UI | PENDING | — |
| 5 | Personalization engine | PENDING | — |
| 5 | Bounce handling | PENDING | — |
| 5 | API & Webhooks | PENDING | — |
| 5 | Regional Outreach (EN+AR) | PENDING | — |
| 5 | WhatsApp Quotes stub | PENDING | — |

(updated as phases land)

## Rollback events
(none yet)

## Manual steps still on the user
1. Cloudflare Access — add path bypasses for new public endpoints once Phase 2/3 land:
   - `/track/*`
   - `/r`
   - `/u/*`
   - (already bypassed: `/health`, `/csp-report`, `/oauth/google/callback`)
2. R2 lifecycle rule for `icrv-uploads/imports/` — suggest 7-day retention (~30 sec dashboard)
3. R2 lifecycle rule for `icrv-exports/d1-backups/` (already in place per make-it-real run; verify)
4. CAN-SPAM physical address — `/settings/compliance` (after Phase 2 ships)
5. Cost caps: ElevenLabs, RingCentral, Anthropic, Cloudflare (5 min)
6. DNS for tracking domain (only if user later asks for one): track.americanironus.com → CNAME api.icrv.americanironus.com
