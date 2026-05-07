-- 0007_quotes.sql — v2.7 real WhatsApp quotes module
-- Replaces the v2.5 "Coming soon" stub with a working quote table.

CREATE TABLE IF NOT EXISTS quotes (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  quote_number    TEXT NOT NULL,                 -- human-readable, unique per tenant
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | sent | accepted | declined | expired
  currency        TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents  INTEGER NOT NULL DEFAULT 0,
  tax_cents       INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL DEFAULT 0,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  notes           TEXT,
  channel         TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | email | manual
  wa_message_id   TEXT,
  created_by      TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  sent_at         TEXT,
  accepted_at     TEXT,
  expires_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotes_tenant_status ON quotes(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_contact      ON quotes(tenant_id, contact_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_quotes_tenant_number ON quotes(tenant_id, quote_number);

INSERT OR IGNORE INTO _migrations (filename) VALUES ('0007_quotes.sql');
