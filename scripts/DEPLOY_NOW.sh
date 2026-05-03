#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# IRON CUSTOMER REACH VMAX — Complete Deployment Script
# Generated: 2026-04-27
#
# PREREQUISITES (run once before this script):
#   export CLOUDFLARE_API_TOKEN="<your_cf_api_token>"
#   npm install -g wrangler
#
# INFRASTRUCTURE ALREADY PROVISIONED (do NOT re-run setup-d1.sh):
#   D1:  icrv-db              → fdf24661-6675-4570-b1b7-f2b672cad4bf
#   KV:  ICRV_KV_CONFIG       → ab921928cea14fbe9756f9a67ae3c1d3
#   KV:  ICRV_KV_OAUTH        → 5e605b3a83994ee5b78b084d6b561d0b
#   KV:  ICRV_KV_RATE         → daf3f5efc06346a1a383150ab1de37da
#   KV:  ICRV_KV_IDEMP        → 878fe6fdfa844b9d96df8017ac39ee63
#   KV:  ICRV_KV_TRACK        → 7926181a73194dd2a2e14307cb7d4a27
#   R2:  icrv-media, icrv-uploads, icrv-exports, icrv-transcripts, icrv-evidence
#   D1 schema: 18 tables + 30 indexes applied ✅
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo "═══════════════════════════════════════════════════"
echo " IRON CUSTOMER REACH VMAX — DEPLOYMENT"
echo "═══════════════════════════════════════════════════"

# ── STEP 1: Create Queues ────────────────────────────────────────
echo ""
echo "▶ STEP 1: Creating Cloudflare Queues..."
QUEUES=(
  icrv-email-out
  icrv-email-in
  icrv-wa-out
  icrv-wa-in
  icrv-voice-postcall
  icrv-agent-jobs
  icrv-retry
  icrv-dlq
)
for Q in "${QUEUES[@]}"; do
  wrangler queues create "$Q" 2>/dev/null && echo "  ✅ Created: $Q" || echo "  ⚠️  Already exists (OK): $Q"
done

# ── STEP 2: Install dependencies ────────────────────────────────
echo ""
echo "▶ STEP 2: Installing dependencies..."
cd "$ROOT"
npm install --workspaces --if-present 2>&1 | tail -3

# ── STEP 3: Set Secrets ─────────────────────────────────────────
echo ""
echo "▶ STEP 3: Setting secrets..."
echo "  You will be prompted for each secret value."
echo "  Press ENTER to skip (if already set)."
echo ""

set_secret() {
  local worker="$1" key="$2"
  read -rsp "  ${worker} → ${key}: " val
  echo ""
  if [[ -n "$val" ]]; then
    echo "$val" | wrangler secret put "$key" --name "$worker"
    echo "  ✅ Set"
  else
    echo "  ⏭  Skipped"
  fi
}

# icrv-api
echo "--- icrv-api ---"
set_secret icrv-api MASTER_KEK
set_secret icrv-api JWT_SIGNING_KEY
set_secret icrv-api GOOGLE_CLIENT_ID
set_secret icrv-api GOOGLE_CLIENT_SECRET
set_secret icrv-api WA_APP_SECRET
set_secret icrv-api RC_JWT
set_secret icrv-api EL_API_KEY
set_secret icrv-api EL_WEBHOOK_SECRET

# icrv-hooks
echo "--- icrv-hooks ---"
set_secret icrv-hooks MASTER_KEK
set_secret icrv-hooks WA_APP_SECRET
set_secret icrv-hooks RC_WEBHOOK_TOKEN
set_secret icrv-hooks EL_WEBHOOK_SECRET

# icrv-email
echo "--- icrv-email ---"
set_secret icrv-email MASTER_KEK
set_secret icrv-email GOOGLE_CLIENT_ID
set_secret icrv-email GOOGLE_CLIENT_SECRET

# icrv-whatsapp
echo "--- icrv-whatsapp ---"
set_secret icrv-whatsapp MASTER_KEK

# icrv-voice
echo "--- icrv-voice ---"
set_secret icrv-voice MASTER_KEK
set_secret icrv-voice ANTHROPIC_API_KEY
set_secret icrv-voice EL_LLM_SHARED_SECRET

# icrv-consumer
echo "--- icrv-consumer ---"
set_secret icrv-consumer MASTER_KEK
set_secret icrv-consumer GOOGLE_CLIENT_ID
set_secret icrv-consumer GOOGLE_CLIENT_SECRET
set_secret icrv-consumer ANTHROPIC_API_KEY

# icrv-agent
echo "--- icrv-agent ---"
set_secret icrv-agent MASTER_KEK
set_secret icrv-agent ANTHROPIC_API_KEY
set_secret icrv-agent GOOGLE_CLIENT_ID
set_secret icrv-agent GOOGLE_CLIENT_SECRET

# icrv-cron
echo "--- icrv-cron ---"
set_secret icrv-cron MASTER_KEK
set_secret icrv-cron ANTHROPIC_API_KEY

# ── STEP 4: Deploy Workers (ORDER MATTERS) ───────────────────────
echo ""
echo "▶ STEP 4: Deploying workers..."

deploy_worker() {
  local name="$1" dir="$2"
  echo "  Deploying ${name}..."
  (cd "$ROOT/$dir" && wrangler deploy --compatibility-date 2024-10-22) \
    && echo "  ✅ ${name} deployed" \
    || { echo "  ❌ ${name} FAILED"; exit 1; }
}

# icrv-api first (registers DOs referenced by other workers)
deploy_worker icrv-api       workers/icrv-api
# icrv-agent second (registers AgentSessionDO)
deploy_worker icrv-agent     workers/icrv-agent
# Channel workers
deploy_worker icrv-email     workers/icrv-email
deploy_worker icrv-whatsapp  workers/icrv-whatsapp
deploy_worker icrv-voice     workers/icrv-voice
# Inbound + consumer
deploy_worker icrv-hooks     workers/icrv-hooks
deploy_worker icrv-consumer  workers/icrv-consumer
# Cron last
deploy_worker icrv-cron      workers/icrv-cron

# ── STEP 5: Deploy Frontend ──────────────────────────────────────
echo ""
echo "▶ STEP 5: Deploying frontend (Cloudflare Pages)..."
cd "$ROOT/frontend"
npm install 2>&1 | tail -3
npm run build 2>&1 | tail -5
wrangler pages deploy dist --project-name icrv-dashboard \
  && echo "  ✅ Frontend deployed" \
  || echo "  ❌ Frontend FAILED"

# ── STEP 6: Seed KV ─────────────────────────────────────────────
echo ""
echo "▶ STEP 6: Seeding KV_CONFIG..."
read -rsp "  WhatsApp verify token (WA_VERIFY_TOKEN): " WA_TOKEN
echo ""
if [[ -n "$WA_TOKEN" ]]; then
  wrangler kv key put whatsapp_verify_token "$WA_TOKEN" \
    --namespace-id ab921928cea14fbe9756f9a67ae3c1d3
  echo "  ✅ WhatsApp verify token seeded"
fi

read -rsp "  GCP Project ID (for Gmail Pub/Sub): " GCP_ID
echo ""
if [[ -n "$GCP_ID" ]]; then
  wrangler kv key put gcp_project_id "$GCP_ID" \
    --namespace-id ab921928cea14fbe9756f9a67ae3c1d3
  echo "  ✅ GCP project ID seeded"
fi

# ── DONE ────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo " DEPLOYMENT COMPLETE"
echo "═══════════════════════════════════════════════════"
echo ""
echo "POST-DEPLOY CHECKLIST:"
echo "  □ Set custom domain: api.icrv.app → icrv-api worker"
echo "  □ Set custom domain: hooks.icrv.app → icrv-hooks worker"  
echo "  □ Configure CF Access policy for /v1/* routes"
echo "  □ Register Gmail Pub/Sub push to https://hooks.icrv.app/hooks/gmail/push"
echo "  □ Register WhatsApp webhook: https://hooks.icrv.app/hooks/whatsapp"
echo "  □ Register RingCentral webhook: https://hooks.icrv.app/hooks/ringcentral"
echo "  □ Register ElevenLabs webhook: https://hooks.icrv.app/hooks/elevenlabs"
echo "  □ Set ElevenLabs custom-LLM URL: https://<icrv-voice-url>/llm/v1/chat/completions"
echo "  □ Confirm cron triggers active in CF dashboard"
echo ""
