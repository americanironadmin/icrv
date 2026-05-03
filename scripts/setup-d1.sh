#!/usr/bin/env bash
# setup-d1.sh — Create D1 database and apply schema
# Run once per environment before deploying workers.
set -euo pipefail

DB_NAME="${1:-icrv-db}"
SCHEMA_FILE="$(dirname "$0")/../schema.sql"

echo "==> Creating D1 database: $DB_NAME"
DB_OUTPUT=$(wrangler d1 create "$DB_NAME" 2>&1) || true
echo "$DB_OUTPUT"

# Extract database_id from output
DB_ID=$(echo "$DB_OUTPUT" | grep -oP '(?<=database_id = ")[^"]+' || true)
if [[ -z "$DB_ID" ]]; then
  echo "WARN: Could not extract database_id automatically."
  echo "      Check 'wrangler d1 list' and update REPLACE_WITH_D1_DATABASE_ID in all wrangler.toml files."
else
  echo "==> Database ID: $DB_ID"
  echo "==> Patching wrangler.toml files with database_id..."
  find "$(dirname "$0")/.." -name "wrangler.toml" -exec \
    sed -i "s/REPLACE_WITH_D1_DATABASE_ID/$DB_ID/g" {} \;
  echo "==> Done patching."
fi

echo "==> Applying schema to local D1..."
wrangler d1 execute "$DB_NAME" --local --file="$SCHEMA_FILE"

echo "==> Applying schema to remote D1..."
wrangler d1 execute "$DB_NAME" --remote --file="$SCHEMA_FILE"

echo ""
echo "✅ D1 setup complete."
echo "   Next: run create-queues.sh, then deploy-all.sh"
