-- 0005_phase5.sql — Phase 5: personalization + bounces + webhooks.

-- contacts: custom_fields_json + bounce/complaint counters
ALTER TABLE contacts ADD COLUMN custom_fields_json TEXT;
ALTER TABLE contacts ADD COLUMN bounce_count       INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN complaint_count    INTEGER DEFAULT 0;

-- templates: tags column to support tag filtering in the library UI
ALTER TABLE templates ADD COLUMN tags_json TEXT;

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  event       TEXT NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  is_active   INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_tenant ON webhook_subscriptions(tenant_id, event);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event           TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt         INTEGER DEFAULT 0,
  last_status_code INTEGER,
  last_error      TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  delivered_at    TEXT,
  next_retry_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant ON webhook_deliveries(tenant_id, created_at DESC);

-- Tenant-scoped API keys (sk_*) — store sha256(key) only.
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  last4       TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id, revoked_at);

INSERT OR IGNORE INTO _migrations (filename) VALUES ('0005_phase5.sql');
