#!/usr/bin/env bash
# scripts/audit-check.sh
# Re-runs the post-deploy verification recipe from CC-PROMPT-icrv-hardening.md
# against a Pages preview URL and the matching API preview URL.
#
# Usage:
#   bash scripts/audit-check.sh <pages-preview-url> <api-preview-url>
#
# Example:
#   bash scripts/audit-check.sh \
#     https://hardening-07.icrv-dashboard.pages.dev \
#     https://icrv-api-preview.americanironadmin.workers.dev

set -e

HOST="${1:?usage: $0 <pages-preview-url> <api-preview-url>}"
API="${2:?api preview url required}"

section() { echo; echo "=== $1 ==="; }

section "Security headers (PR 1, PR 2)"
curl -sI "$HOST/contacts" | grep -iE "content-security-policy|strict-transport|x-frame|permissions-policy|cross-origin-opener|x-content-type"

section "Cache headers on hashed assets (PR 1)"
JS=$(curl -s "$HOST/contacts" | grep -oE 'index-[A-Za-z0-9]+\.js' | head -1)
if [ -n "$JS" ]; then
  curl -sI "$HOST/assets/$JS" | grep -i cache-control
else
  echo "  could not extract bundle filename — does /contacts return SPA HTML?"
fi

section "robots.txt is real text (PR 1)"
curl -sI "$HOST/robots.txt" | grep -iE "content-type|cache-control"
curl -s "$HOST/robots.txt" | head -3

section "404 returns 404 (PR 1)"
curl -sI "$HOST/this-route-does-not-exist-xyz" | head -1

section "API requires auth (PR 6 final state)"
for ep in /v1/contacts /v1/dashboard/status /v1/admin/integrations /v1/agent-controls/kill-switch /v1/auth/me; do
  printf "  %-40s %s\n" "$ep" "$(curl -s -o /dev/null -w "%{http_code}" "$API$ep")"
done

section "Rate limit kicks in (PR 3)"
codes=""
for i in $(seq 1 25); do
  codes="$codes $(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer x" "$API/v1/auth/me")"
done
echo " $codes"
echo " (expect 401s or 400s, then 429s — PR 6 returns 400 browser_bearer_disallowed if CORS Origin is set)"

section "CORS reflects with Vary (PR 3)"
curl -sI -H "Origin: https://app.icrv.app" "$API/health" | grep -iE "access-control|vary"

section "No legacy token storage in bundle (PR 6)"
JS_FULL=$(curl -s "$HOST/contacts" | grep -oE '/assets/index-[A-Za-z0-9]+\.js' | head -1)
if [ -n "$JS_FULL" ]; then
  COUNT=$(curl -s "$HOST$JS_FULL" | grep -c 'icrv_token' || true)
  echo " icrv_token occurrences in bundle: $COUNT (expect 0 after PR 6)"
fi

section "Sentry initialized in bundle (PR 4)"
if [ -n "${JS_FULL:-}" ]; then
  SENTRY=$(curl -s "$HOST$JS_FULL" | grep -c 'sentry' || true)
  echo " sentry references: $SENTRY (expect >0)"
fi
