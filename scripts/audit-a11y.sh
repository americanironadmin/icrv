#!/usr/bin/env bash
# scripts/audit-a11y.sh
# PR 7 / L4: walks every sidebar route through axe-core CLI and exits non-zero
# on any Serious or Critical violation. Run after each preview deploy.
#
# Usage:
#   PREVIEW_URL=https://hardening-07.icrv-dashboard.pages.dev npm run audit:a11y
#
# Requires axe-core/cli (installed as a devDependency).

set -euo pipefail

PREVIEW_URL="${PREVIEW_URL:-}"
if [ -z "$PREVIEW_URL" ]; then
  echo "ERROR: set PREVIEW_URL to a deployed Pages URL, e.g."
  echo "  PREVIEW_URL=https://hardening-07.icrv-dashboard.pages.dev npm run audit:a11y"
  exit 2
fi

ROUTES=( "" "/contacts" "/campaigns" "/ai" "/logs" "/calls" "/settings" )
TAGS="wcag2a,wcag2aa,wcag21aa"
FAILED=0

for r in "${ROUTES[@]}"; do
  url="${PREVIEW_URL}${r}"
  echo
  echo "=== axe ${url} ==="
  if ! npx axe "$url" --tags "$TAGS" --exit; then
    FAILED=$((FAILED + 1))
  fi
done

echo
if [ "$FAILED" -gt 0 ]; then
  echo "FAIL: $FAILED route(s) reported Serious / Critical violations."
  exit 1
fi
echo "PASS: zero Serious / Critical violations across $(( ${#ROUTES[@]} )) routes."
