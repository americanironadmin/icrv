-- 0003_tracking_events.sql
-- Phase 3 — open/click/bounce/unsubscribe/complaint events.

CREATE TABLE IF NOT EXISTS tracking_events (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  contact_id   TEXT,
  campaign_id  TEXT,
  type         TEXT NOT NULL,
  url          TEXT,
  ip           TEXT,
  user_agent   TEXT,
  occurred_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tracking_tenant_type ON tracking_events(tenant_id, type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracking_campaign    ON tracking_events(campaign_id, type);

INSERT OR IGNORE INTO _migrations (filename) VALUES ('0003_tracking_events.sql');
