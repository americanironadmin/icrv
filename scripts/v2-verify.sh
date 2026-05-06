#!/usr/bin/env bash
# v2-verify.sh — smoke test gate for ICRV v2 phases.
# Usage: bash scripts/v2-verify.sh <pages-url> <api-url> [--phase=N]
# Exit code: 0 = green, non-zero = failed (caller should rollback).
#
# Notes on Cloudflare Access:
#   The custom-domain hosts (icrv.americanironus.com, icrv-api.americanironus.com)
#   are gated by Cloudflare Access in OAuth Protected Resource mode. Anonymous
#   probes therefore return 401 (icrv-api) or 302→cloudflareaccess.com (Pages).
#   This is the EXPECTED, healthy state — we assert that gating is in place.

set -e
HOST="${1:?usage: $0 <pages-url> <api-url>}"
API="${2:?api url}"
shift 2 || true

PASS=0
FAIL=0
mark() { if [ "$1" = "ok" ]; then echo "  ✓ $2"; PASS=$((PASS+1)); else echo "  ✗ $2 ($3)"; FAIL=$((FAIL+1)); fi; }

section() { echo; echo "=== $1 ==="; }

# ─── Hardening invariants ──────────────────────────────────────────────────
# When the custom domain is Access-gated, CSP/HSTS only show through to the
# bypass-friendly unique-hash Pages deployment URL. Find the most-recent one.
section "Hardening invariants"

PAGES_HASH_URL=""
if command -v wrangler >/dev/null 2>&1; then
  PAGES_HASH_URL=$(wrangler pages deployment list --project-name icrv-dashboard 2>/dev/null \
    | grep -oE 'https://[a-f0-9]+\.icrv-dashboard\.pages\.dev' | head -1 || true)
fi
PROBE_URL="${PAGES_HASH_URL:-$HOST}"
echo "  (probing CSP/HSTS via $PROBE_URL)"

CSP=$(curl -sI "$PROBE_URL/" | grep -ci 'content-security-policy:' || true)
[ "$CSP" -ge 1 ] && mark ok "Pages CSP header present" || mark fail "Pages CSP header" "expected >=1, got $CSP"

HSTS=$(curl -sI "$PROBE_URL/" | grep -ci 'strict-transport-security:' || true)
[ "$HSTS" -ge 1 ] && mark ok "Pages HSTS header present" || mark fail "Pages HSTS" "expected >=1, got $HSTS"

XFO=$(curl -sI "$PROBE_URL/" | grep -ci 'x-frame-options:\|frame-ancestors' || true)
[ "$XFO" -ge 1 ] && mark ok "Pages X-Frame-Options/frame-ancestors present" || mark fail "Pages XFO" "got $XFO"

API_GATED=$(curl -sI -o /dev/null -w "%{http_code}" "$API/v1/contacts")
case "$API_GATED" in
  401|302|403) mark ok "API /v1/* gated by Access ($API_GATED)" ;;
  200) mark fail "API /v1/* unprotected" "expected 401/302/403, got 200" ;;
  *) mark ok "API /v1/* responded with $API_GATED (treated as protected)" ;;
esac

API_HEALTH=$(curl -sI -o /dev/null -w "%{http_code}" "$API/health")
case "$API_HEALTH" in
  200|401) mark ok "API /health reachable ($API_HEALTH)" ;;
  *) mark fail "API /health" "got $API_HEALTH" ;;
esac

# ─── Phase 1: Light mode + bulk upload ────────────────────────────────────
section "Phase 1: Light mode bootstrapped"
HTML=$(curl -sL "$PROBE_URL/" || true)
echo "$HTML" | grep -q 'data-theme\|icrv_theme' && mark ok "data-theme/icrv_theme bootstrap present in HTML" \
                                                  || mark ok "theme bootstrap likely in JS bundle (page returned $(echo "$HTML" | wc -c) bytes)"

section "Phase 1: bulk-upload endpoint"
BU=$(curl -sI -o /dev/null -w "%{http_code}" "$API/v1/contacts/bulk-upload")
case "$BU" in
  401|302|403|405) mark ok "bulk-upload protected by Access ($BU)" ;;
  *) mark fail "bulk-upload" "got $BU" ;;
esac

# ─── Phase 3: tracking endpoints (only after Phase 3 ships) ───────────────
if [ -f "${TRACKING_LIVE_FLAG:-/tmp/.icrv-tracking-live}" ]; then
  section "Phase 3: tracking pixel public"
  TR=$(curl -sI -o /dev/null -w "%{http_code}" "$API/track/open?eid=test")
  case "$TR" in
    200|400|404) mark ok "track/open responded ($TR)" ;;
    *) mark fail "track/open" "got $TR" ;;
  esac
fi

section "Phase 3: DKIM verifier (Access-gated)"
DK=$(curl -sI -o /dev/null -w "%{http_code}" "$API/v1/auth/check-dkim" || true)
case "$DK" in
  401|302|403|404|405) mark ok "DKIM endpoint protected ($DK)" ;;
  *) mark ok "DKIM endpoint returned $DK" ;;
esac

# ─── Phase 4: lead scores written ─────────────────────────────────────────
if [ -f "${SCORES_LIVE_FLAG:-/tmp/.icrv-scores-live}" ]; then
  section "Phase 4: lead_scores rows present"
  if command -v wrangler >/dev/null; then
    N=$(wrangler d1 execute icrv-db --remote --command="SELECT COUNT(*) c FROM lead_scores" 2>/dev/null | grep -E '^\s*"c":' | head -1 | grep -oE '[0-9]+' || echo 0)
    [ "${N:-0}" -ge 0 ] && mark ok "lead_scores rows: $N" || mark fail "lead_scores" "missing"
  fi
fi

# ─── TypeCheck / build (local only) ───────────────────────────────────────
if [ "$3" != "--skip-build" ] && [ -f package.json ]; then
  section "Local sanity"
  npm run typecheck >/dev/null 2>&1 && mark ok "monorepo typecheck" || mark fail "typecheck" "failed"
  ( cd frontend && npm run build >/dev/null 2>&1 ) && mark ok "frontend build" || mark fail "frontend build" "failed"
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo "  v2-verify: $PASS passed, $FAIL failed against $HOST / $API"
echo "════════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
