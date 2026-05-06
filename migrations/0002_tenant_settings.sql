-- 0002_tenant_settings.sql
-- Phase 2 — workspace, compliance, sending, tracking, authentication,
-- personalization, bounce, api/webhooks settings stored as section JSON.

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id            TEXT PRIMARY KEY,
  workspace_json       TEXT NOT NULL DEFAULT '{}',
  compliance_json      TEXT NOT NULL DEFAULT '{}',
  sending_json         TEXT NOT NULL DEFAULT '{}',
  tracking_json        TEXT NOT NULL DEFAULT '{}',
  authentication_json  TEXT NOT NULL DEFAULT '{}',
  personalization_json TEXT NOT NULL DEFAULT '{}',
  bounce_json          TEXT NOT NULL DEFAULT '{}',
  api_webhooks_json    TEXT NOT NULL DEFAULT '{}',
  updated_at           TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO _migrations (filename) VALUES ('0002_tenant_settings.sql');
