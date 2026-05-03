#!/usr/bin/env bash
# deploy-all.sh — Deploy all ICRV workers in dependency order
# icrv-api MUST deploy first (it defines all Durable Objects)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "════════════════════════════════════════════════"
echo "  IRON CUSTOMER REACH VMAX — Full Deploy"
echo "════════════════════════════════════════════════"
echo ""

deploy_worker() {
  local worker="$1"
  echo "──── Deploying $worker ────"
  cd "$ROOT/workers/$worker"
  wrangler deploy
  echo "✓ $worker deployed"
  echo ""
  cd "$ROOT"
}

# 1. icrv-api first — registers all 5 Durable Object classes
deploy_worker "icrv-api"

# 2. Channel workers (can deploy in any order after icrv-api)
deploy_worker "icrv-hooks"
deploy_worker "icrv-email"
deploy_worker "icrv-whatsapp"
deploy_worker "icrv-voice"
deploy_worker "icrv-agent"

# 3. Consumer and cron last
deploy_worker "icrv-consumer"
deploy_worker "icrv-cron"

echo "════════════════════════════════════════════════"
echo "  ✅ All 8 workers deployed successfully"
echo "════════════════════════════════════════════════"
echo ""
echo "Post-deploy checklist:"
echo "  □ Configure Cloudflare Access policies for /admin/* and /api/internal/*"
echo "  □ Point icrv-api custom domain: api.icrv.app"
echo "  □ Point icrv-hooks custom domain: hooks.icrv.app"
echo "  □ Register Gmail Pub/Sub push subscription pointing to: https://hooks.icrv.app/hooks/gmail/push"
echo "  □ Register WhatsApp webhook: https://hooks.icrv.app/hooks/whatsapp"
echo "  □ Register RingCentral webhook: https://hooks.icrv.app/hooks/ringcentral"
echo "  □ Register ElevenLabs webhook: https://hooks.icrv.app/hooks/elevenlabs"
echo "  □ Verify cron triggers are active in Cloudflare dashboard"
