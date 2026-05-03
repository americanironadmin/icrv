#!/usr/bin/env bash
# create-queues.sh — Provision all Cloudflare Queues, KV namespaces, and R2 buckets
set -euo pipefail

echo "════════════════════════════════════════"
echo "  IRON CUSTOMER REACH VMAX — Infra Setup"
echo "════════════════════════════════════════"

# ── Queues ────────────────────────────────────────────────────────────────────
QUEUES=(
  "icrv-email-out"
  "icrv-email-in"
  "icrv-wa-out"
  "icrv-wa-in"
  "icrv-voice-postcall"
  "icrv-agent-jobs"
  "icrv-retry"
  "icrv-dlq"
)

echo ""
echo "==> Creating Queues..."
for q in "${QUEUES[@]}"; do
  echo "    queue: $q"
  wrangler queues create "$q" 2>&1 | grep -v "already exists" || true
done

# ── KV Namespaces ─────────────────────────────────────────────────────────────
KV_NAMESPACES=(
  "ICRV_CONFIG"
  "ICRV_OAUTH"
  "ICRV_RATE"
  "ICRV_IDEMP"
  "ICRV_TRACK"
)

KV_BINDING_VARS=(
  "KV_CONFIG"
  "KV_OAUTH"
  "KV_RATE"
  "KV_IDEMP"
  "KV_TRACK"
)

KV_REPLACE_VARS=(
  "REPLACE_WITH_KV_CONFIG_ID"
  "REPLACE_WITH_KV_OAUTH_ID"
  "REPLACE_WITH_KV_RATE_ID"
  "REPLACE_WITH_KV_IDEMP_ID"
  "REPLACE_WITH_KV_TRACK_ID"
)

echo ""
echo "==> Creating KV Namespaces..."
for i in "${!KV_NAMESPACES[@]}"; do
  ns="${KV_NAMESPACES[$i]}"
  replace="${KV_REPLACE_VARS[$i]}"
  echo "    kv: $ns"
  KV_OUT=$(wrangler kv namespace create "$ns" 2>&1) || true
  echo "$KV_OUT"
  KV_ID=$(echo "$KV_OUT" | grep -oP '(?<=id = ")[^"]+' || true)
  if [[ -n "$KV_ID" ]]; then
    find "$(dirname "$0")/.." -name "wrangler.toml" -exec \
      sed -i "s/$replace/$KV_ID/g" {} \;
    echo "    ✓ $ns = $KV_ID"
  fi
done

# ── R2 Buckets ────────────────────────────────────────────────────────────────
R2_BUCKETS=(
  "icrv-media"
  "icrv-uploads"
  "icrv-exports"
  "icrv-transcripts"
  "icrv-evidence"
)

echo ""
echo "==> Creating R2 Buckets..."
for bucket in "${R2_BUCKETS[@]}"; do
  echo "    r2: $bucket"
  wrangler r2 bucket create "$bucket" 2>&1 | grep -v "already exists" || true
done

echo ""
echo "✅ Infra provisioning complete."
echo ""
echo "Next steps:"
echo "  1. Set secrets for each worker:"
echo "     wrangler secret put MASTER_KEK --name icrv-api"
echo "     wrangler secret put WA_APP_SECRET --name icrv-api"
echo "     wrangler secret put RC_JWT --name icrv-api"
echo "     wrangler secret put EL_API_KEY --name icrv-api"
echo "     wrangler secret put EL_WEBHOOK_SECRET --name icrv-api"
echo "     wrangler secret put GOOGLE_CLIENT_SECRET --name icrv-api"
echo "     wrangler secret put JWT_SIGNING_KEY --name icrv-api"
echo "     wrangler secret put ANTHROPIC_API_KEY --name icrv-consumer"
echo "     wrangler secret put ANTHROPIC_API_KEY --name icrv-agent"
echo ""
echo "  2. Run: bash scripts/deploy-all.sh"
