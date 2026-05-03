# IRON CUSTOMER REACH VMAX — Environment Variable & Binding Reference
# ====================================================================
# All values listed here are REQUIRED.
# NO values are fake — every entry maps to a real API or infrastructure resource.
#
# Set secrets with:   wrangler secret put <VAR_NAME> --name <worker_name>
# Set vars with:      wrangler.toml [vars] section (non-sensitive only)
#
# ────────────────────────────────────────────────────────────────────
# MASTER SECRET — applies to ALL workers that touch api_credentials
# ────────────────────────────────────────────────────────────────────

MASTER_KEK
  Worker(s): icrv-api, icrv-email, icrv-whatsapp, icrv-voice, icrv-consumer
  Type:      wrangler secret
  Format:    64 hex chars (32 random bytes)
  Generate:  openssl rand -hex 32
  Purpose:   Master key-encryption key for envelope encryption of all stored credentials

# ────────────────────────────────────────────────────────────────────
# icrv-api
# ────────────────────────────────────────────────────────────────────

JWT_SIGNING_KEY
  Type:    wrangler secret
  Format:  64+ random chars (used for signing internal JWTs)
  Generate: openssl rand -hex 32

GOOGLE_CLIENT_ID
  Type:    wrangler secret
  Source:  Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID
  Scope:   https://www.googleapis.com/auth/gmail.send
           https://www.googleapis.com/auth/gmail.readonly

GOOGLE_CLIENT_SECRET
  Type:    wrangler secret
  Source:  Google Cloud Console → same OAuth 2.0 client

WA_APP_SECRET
  Type:    wrangler secret
  Source:  Meta for Developers → App Dashboard → Settings → Basic → App Secret
  Purpose: HMAC-SHA256 verification of incoming WhatsApp webhooks

WA_VERIFY_TOKEN
  Type:    wrangler secret (also stored in KV_CONFIG as 'whatsapp_verify_token')
  Format:  Any random string you choose
  Purpose: WhatsApp webhook verification challenge

RC_JWT
  Type:    wrangler secret
  Source:  RingCentral Developer Console → App → Credentials → Download JWT
  Purpose: Server-to-server JWT grant for RC OAuth token exchange

EL_API_KEY
  Type:    wrangler secret
  Source:  ElevenLabs → Profile → API Keys
  Purpose: ElevenLabs API authentication

EL_WEBHOOK_SECRET
  Type:    wrangler secret
  Source:  ElevenLabs → Developer → Webhooks → signing secret
  Purpose: HMAC-SHA256 verification of ElevenLabs webhook events

# ────────────────────────────────────────────────────────────────────
# icrv-hooks
# ────────────────────────────────────────────────────────────────────

WA_APP_SECRET         (same as above — also bound to icrv-hooks)
RC_WEBHOOK_TOKEN
  Type:    wrangler secret
  Source:  Your own random token; set when creating the RC subscription in KV_CONFIG
  Note:    RC uses this as the HMAC key for X-Rc-Hmac-Sha256 header

EL_WEBHOOK_SECRET     (same as above — also bound to icrv-hooks)

GMAIL_PUBSUB_AUD
  Type:    wrangler var (not secret — it's the public endpoint URL)
  Value:   https://hooks.icrv.app/hooks/gmail/push
  Purpose: JWT audience claim that Google Pub/Sub includes in its OIDC token

HOOKS_DOMAIN
  Type:    wrangler var
  Value:   hooks.icrv.app

# ────────────────────────────────────────────────────────────────────
# icrv-consumer
# ────────────────────────────────────────────────────────────────────

ANTHROPIC_API_KEY
  Type:    wrangler secret
  Source:  https://console.anthropic.com → API Keys
  Purpose: Anthropic API calls from icrv-consumer / icrv-agent

AI_MODEL
  Type:    wrangler var
  Value:   claude-sonnet-4-20250514
  Note:    Always use Sonnet 4 as per project configuration

GOOGLE_CLIENT_ID      (same as above — also bound to icrv-consumer via OAUTH_DO)
GOOGLE_CLIENT_SECRET  (same as above)
MASTER_KEK            (same as above)

# ────────────────────────────────────────────────────────────────────
# icrv-email (worker vars — bindings via wrangler.toml)
# ────────────────────────────────────────────────────────────────────

GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
MASTER_KEK

# ────────────────────────────────────────────────────────────────────
# icrv-cron (additional beyond BaseEnv)
# ────────────────────────────────────────────────────────────────────

HOOKS_BASE_URL
  Type:    wrangler var
  Value:   https://hooks.icrv.app

RC_CREDENTIAL_IDS
  Type:    wrangler var
  Value:   comma-separated list of api_credentials.id values for RC credentials to renew
  Example: "01ABCDEF...,01GHIJKL..."

# ────────────────────────────────────────────────────────────────────
# INITIAL SETUP SEQUENCE (run once per environment)
# ────────────────────────────────────────────────────────────────────

# Step 1: Provision infrastructure
bash scripts/setup-d1.sh
bash scripts/create-queues.sh

# Step 2: Set all secrets
wrangler secret put MASTER_KEK               --name icrv-api
wrangler secret put JWT_SIGNING_KEY          --name icrv-api
wrangler secret put GOOGLE_CLIENT_ID         --name icrv-api
wrangler secret put GOOGLE_CLIENT_SECRET     --name icrv-api
wrangler secret put WA_APP_SECRET            --name icrv-api
wrangler secret put RC_JWT                   --name icrv-api
wrangler secret put EL_API_KEY               --name icrv-api
wrangler secret put EL_WEBHOOK_SECRET        --name icrv-api

wrangler secret put WA_APP_SECRET            --name icrv-hooks
wrangler secret put RC_WEBHOOK_TOKEN         --name icrv-hooks
wrangler secret put EL_WEBHOOK_SECRET        --name icrv-hooks
wrangler secret put MASTER_KEK              --name icrv-hooks

wrangler secret put MASTER_KEK              --name icrv-email
wrangler secret put GOOGLE_CLIENT_ID        --name icrv-email
wrangler secret put GOOGLE_CLIENT_SECRET    --name icrv-email

wrangler secret put ANTHROPIC_API_KEY       --name icrv-consumer
wrangler secret put MASTER_KEK             --name icrv-consumer
wrangler secret put GOOGLE_CLIENT_ID       --name icrv-consumer
wrangler secret put GOOGLE_CLIENT_SECRET   --name icrv-consumer

wrangler secret put MASTER_KEK             --name icrv-voice
wrangler secret put MASTER_KEK             --name icrv-whatsapp
wrangler secret put MASTER_KEK             --name icrv-agent
wrangler secret put ANTHROPIC_API_KEY      --name icrv-agent

# Step 3: Seed KV_CONFIG with WhatsApp verify token
# (run once via wrangler kv key put)
wrangler kv key put whatsapp_verify_token "<your_random_token>" \
  --binding KV_CONFIG --env production

# Step 4: Deploy
bash scripts/deploy-all.sh

# Step 5: Post-deploy (from deploy-all.sh checklist)
# □ Configure Cloudflare Access policies for /admin/* and /api/internal/*
# □ Point icrv-api custom domain: api.icrv.app
# □ Point icrv-hooks custom domain: hooks.icrv.app
# □ Register Gmail Pub/Sub push subscription:
#     gcloud pubsub subscriptions modify-push-config gmail-push-sub \
#       --push-endpoint=https://hooks.icrv.app/hooks/gmail/push \
#       --push-auth-service-account=icrv-pubsub@PROJECT.iam.gserviceaccount.com
# □ Register WhatsApp webhook in Meta developer console:
#     Callback URL: https://hooks.icrv.app/hooks/whatsapp
#     Verify Token: <same as WA_VERIFY_TOKEN secret>
#     Subscribed fields: messages, messaging_postbacks, message_deliveries, message_reads
# □ Register RingCentral webhook subscription (via API or dashboard):
#     POST /restapi/v1.0/subscription
#     address: https://hooks.icrv.app/hooks/ringcentral
# □ Register ElevenLabs webhook in EL dashboard:
#     URL: https://hooks.icrv.app/hooks/elevenlabs
#     Events: conversation.ended, post_call_transcription_complete
# □ Verify cron triggers are active in Cloudflare dashboard

# ────────────────────────────────────────────────────────────────────
# EXTERNAL API REQUIREMENTS
# ────────────────────────────────────────────────────────────────────

# Google Cloud:
#   - Enable: Gmail API, Cloud Pub/Sub API
#   - OAuth consent screen configured with correct scopes
#   - Pub/Sub topic: gmail-push (set via KV_CONFIG['gcp_project_id'])
#   - Service account with: pubsub.subscriptions.consume, iam.serviceAccounts.actAs

# Meta (WhatsApp):
#   - Business Account verified
#   - App in production mode (not development)
#   - Phone number registered and verified
#   - Template messages pre-approved before use

# RingCentral:
#   - App registered in RC Developer Console
#   - App permissions: Read Accounts, Read Presence, Telephony, Webhooks, Call Control
#   - JWT credential downloaded and stored in api_credentials (encrypted)
#   - Phone number(s) enabled for outbound calls

# ElevenLabs:
#   - Conversational AI agent created in dashboard
#   - Telephony add-on enabled (required for outbound phone calls)
#   - Phone number registered (for outbound calling fromPhone)
#   - Agent ID stored in campaign config or trigger payload

# ────────────────────────────────────────────────────────────────────
# Rate limiting (PR 3)
# ────────────────────────────────────────────────────────────────────
# Implemented in packages/shared/src/rate-limit.ts; backed by KV_RATE
# (already provisioned on every worker). Buckets are 60 s sliding-ish
# windows keyed off CF-Connecting-IP plus optional tenant_id.
#
#   /v1/auth/*          10 req / 60 s / IP
#   /v1/* (post-auth)   120 req / 60 s / (IP + tenant)
#   icrv-hooks all      600 req / 60 s / IP   (absorbs legit webhook bursts)
#   icrv-voice all      240 req / 60 s / IP   (covers /llm/v1/* burstiness)
#
# Misconfigured bindings fail open (do not block traffic). On overflow the
# response is 429 with Retry-After + X-RateLimit-* headers.

# ────────────────────────────────────────────────────────────────────
# Token revocation (PR 3)
# ────────────────────────────────────────────────────────────────────

KV_REVOKED
  Worker(s): icrv-api
  Type:      KV namespace
  Provision: wrangler kv namespace create KV_REVOKED
  Purpose:   POST /v1/auth/logout writes `revoked:<jti>` here with TTL =
             (token exp − now). authMiddleware checks it before every
             /v1/* request. After provisioning, replace
             REPLACE_ME_KV_REVOKED_ID in workers/icrv-api/wrangler.toml
             with the returned namespace id, then `wrangler deploy`.

# ────────────────────────────────────────────────────────────────────
# Telemetry — Sentry (PR 4)
# ────────────────────────────────────────────────────────────────────
# All DSNs are optional. Empty value → SDK stays dormant. Every event passes
# through scrubPii (packages/shared/src/sentry-scrub.ts on workers,
# frontend/src/lib/sentry-scrub.ts on Pages) which strips Authorization, Cookie,
# Cf-Access-Jwt-Assertion, plus PII fields (email, phone, *_e164, name,
# tenant_id, user_id, address, ip).

SENTRY_DSN
  Worker(s): icrv-api, icrv-hooks, icrv-voice, icrv-agent
  Type:      wrangler secret (defined as empty string in [vars])
  Set with:  wrangler secret put SENTRY_DSN --name icrv-api
             wrangler secret put SENTRY_DSN --name icrv-hooks
             wrangler secret put SENTRY_DSN --name icrv-voice
             wrangler secret put SENTRY_DSN --name icrv-agent
  Source:    Sentry → Project → Settings → Client Keys (DSN). Reuse the same
             DSN across workers; events are tagged with `service` = worker name.

ENVIRONMENT
  Worker(s): icrv-api, icrv-hooks, icrv-voice, icrv-agent
  Type:      wrangler.toml [vars] (defaults to "production")
  Values:    production | preview | dev — used as Sentry environment tag.

VITE_SENTRY_DSN
  Where:     frontend/.env  (Pages env var on production)
  Source:    Sentry → separate Project for the React app. Optional — empty
             value disables Sentry entirely on the dashboard.
  Notes:     Session replay is OFF by default (this app handles PII).
