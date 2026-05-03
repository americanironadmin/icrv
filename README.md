# IRON CUSTOMER REACH VMAX (ICRV)

Production-grade AI sales engagement platform built **exclusively on Cloudflare**.
Drives multi-channel outbound and inbound communication (Gmail, WhatsApp, voice
over RingCentral SIP + ElevenLabs Conversational AI) under a Claude-powered
agent orchestrator with strict policy gating and per-tenant data isolation.

---

## Architecture

```
                           ┌──────────────────────────────┐
                           │   Cloudflare Access (SSO)    │
                           └──────────────┬───────────────┘
                                          │ CF_Authorization JWT
                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                                FRONTEND                                  │
│   React/Tailwind SPA on Cloudflare Pages — calls api.icrv.app/v1/*       │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  icrv-api (Hono)                                                          │
│   /v1/contacts /v1/campaigns /v1/calls /v1/dashboard /v1/auth/me          │
│   /v1/agent-controls/* (proxied to icrv-agent via service binding)        │
│   Owns DOs:  CampaignCoordinator · ContactInbox · VoiceSession · OAuth    │
└─────────┬──────────────┬──────────────┬──────────────┬──────────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
   ┌───────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐
   │ icrv-     │  │ icrv-      │  │ icrv-      │  │ icrv-voice     │
   │ hooks     │  │ email      │  │ whatsapp   │  │ ─ /place-call  │
   │ (Gmail/   │  │ (Gmail     │  │ (WA Cloud  │  │ ─ /llm/v1/     │
   │ WA/RC/EL  │  │ users.     │  │ Graph      │  │   chat/        │
   │ webhooks) │  │ messages.  │  │ v20.0)     │  │   completions  │
   │           │  │ send)      │  │            │  │   (Haiku 4.5)  │
   └─────┬─────┘  └─────┬──────┘  └─────┬──────┘  └───────┬────────┘
         │              │               │                  │
         ▼              ▼               ▼                  ▼
  ┌──────────────────────────── Cloudflare Queues ───────────────────────┐
  │ icrv-agent-jobs · icrv-email-out · icrv-email-in · icrv-wa-out        │
  │ icrv-wa-in · icrv-voice-postcall · icrv-retry · icrv-dlq              │
  └────────────────────────────┬─────────────────────────────────────────┘
                               ▼
                  ┌──────────────────────────┐       ┌──────────────────┐
                  │ icrv-agent (orchestrator)│ ◄─────│ icrv-consumer    │
                  │  ─ context loader        │       │ (email-in,       │
                  │  ─ policy gate           │       │  retry, DLQ)     │
                  │  ─ Claude Sonnet planner │       └──────────────────┘
                  │  ─ approval gate         │
                  │  ─ dispatcher → channels │
                  │  Owns DO: AgentSession   │
                  └──────────────────────────┘
                               ▲
                               │ schedules / renewals
                  ┌──────────────────────────┐
                  │ icrv-cron (4 schedules)  │
                  └──────────────────────────┘
```

### Voice — realtime conversational LLM

The voice stack is intentionally narrow:

| Plane    | Endpoint / hop                                     | Purpose                              |
|----------|----------------------------------------------------|--------------------------------------|
| Audio    | RingCentral RTP/SRTP ↔ ElevenLabs SIP gateway     | Carries call media. **Never** touches a Worker. |
| Control  | `icrv-voice` `/place-call` → ElevenLabs SIP API   | Initiates outbound conversation, bridges via RC RingOut. |
| Brain    | `icrv-voice` `/llm/v1/chat/completions`           | OpenAI-compatible custom-LLM endpoint. ElevenLabs Conversational AI calls this every turn; we proxy to **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) over Anthropic Messages API and stream SSE deltas back. |
| Postcall | `icrv-voice` queue consumer for `icrv-voice-postcall` | Pulls RC recording → R2_MEDIA, fires `post_call` agent_job. |

Haiku 4.5 is chosen for sub-second turn latency. Claude **Sonnet** 4 is used for
the higher-stakes campaign-step planner inside `icrv-agent`; the two are
independent.

---

## Workspaces

```
packages/
└── shared/                # @icrv/shared — types, crypto, queue helpers, credentials
workers/
├── icrv-api/              # primary HTTP API + 4 DOs
├── icrv-hooks/            # external webhook ingestion + tracking pixels + unsub
├── icrv-email/            # Gmail send producer/consumer
├── icrv-whatsapp/         # WhatsApp Cloud send + inbound
├── icrv-voice/            # SIP bridge, custom-LLM proxy, postcall consumer
├── icrv-consumer/         # email-in, retry, DLQ consumers
├── icrv-agent/            # orchestrator + AgentSessionDO
└── icrv-cron/             # scheduled-only worker (4 crons)
```

Schema lives at `schema.sql` — 24 tables, 8 unique indexes, validated against
SQLite 3.45.

---

## Environment & secrets

See `ENV_REFERENCE.md` for the full matrix. The minimum per-worker secrets are:

| Secret                    | Workers that need it                                    |
|---------------------------|---------------------------------------------------------|
| `MASTER_KEK`              | api, hooks, email, whatsapp, voice, consumer, agent, cron |
| `ANTHROPIC_API_KEY`       | voice (Haiku 4.5 LLM proxy), agent (Sonnet planner)     |
| `JWT_HS256_SECRET`        | api                                                     |
| `WHATSAPP_VERIFY_TOKEN`   | hooks                                                   |
| `WHATSAPP_APP_SECRET`     | hooks                                                   |
| `EL_WEBHOOK_SECRET`       | hooks                                                   |
| `GOOGLE_OIDC_AUDIENCE`    | hooks                                                   |
| `RINGCENTRAL_VERIFICATION_TOKEN` | hooks                                            |

Set with `wrangler secret put NAME --name icrv-<worker>`.

---

## Deploy

Prereqs: Node ≥ 20, npm ≥ 10, `wrangler` authenticated against your CF account.

```bash
# 1. Provision infra (D1 / queues / KV / R2 / DOs)
bash scripts/setup-d1.sh
bash scripts/create-queues.sh
# (KV namespaces, R2 buckets, and Cloudflare Access policy must also be set up;
#  see ENV_REFERENCE.md for the wrangler commands.)

# 2. Apply schema
wrangler d1 execute icrv-db --file=./schema.sql

# 3. Install workspace deps
npm install

# 4. Deploy every worker
npm run deploy:api
npm run deploy:hooks
npm run deploy:email
npm run deploy:whatsapp
npm run deploy:voice
npm run deploy:consumer
npm run deploy:agent
npm run deploy:cron
# OR all at once
npm run deploy:all
```

After every `wrangler.toml` is filled in with real D1/KV/R2/queue IDs, the
matrix workflow at `.github/workflows/deploy.yml` will redeploy each worker on
push to `main`.

---

## Cron schedule

| Cron         | Function                     | Behaviour                                                  |
|--------------|------------------------------|------------------------------------------------------------|
| `* * * * *`  | `runCampaignTick`            | Find due `campaign_enrollments`, check `CampaignCoordinatorDO` daily caps, enqueue agent jobs, advance step pointers. |
| `*/5 * * * *`| `runRenewalCheck`            | Refresh Gmail watches < 24 h to expiry; renew RingCentral subscriptions < 24 h to expiry. |
| `0 * * * *`  | `runRateWindowRoll`          | Flush `KV_TRACK` open/click counters into `message_events`. |
| `0 3 * * *`  | `runNightlyMaintenance`      | 90-day retention purge (audit_logs, message_events, agent_runs); webhook table 30-day purge; nightly per-campaign stats cache to KV. |

---

## Sandbox / build constraints

This codebase was built and type-checked in a sandbox without Cloudflare or
external API access. As a result:

- `wrangler deploy` was **not** executed; every `wrangler.toml` contains
  `REPLACE_WITH_*` placeholders that you must fill in with real IDs from your
  Cloudflare account before deploying.
- The end-to-end audio loop (RingCentral RTP ↔ ElevenLabs ↔ Haiku 4.5 brain)
  cannot be exercised from this build environment; verify it once deployed by
  placing a test outbound call from the dashboard.

Everything else — schema, types, queue payloads, DO contracts, webhook
verification, OAuth refresh, encryption, agent policy gate, frontend wiring —
is wired end-to-end in code.
