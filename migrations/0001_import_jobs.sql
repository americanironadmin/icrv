-- 0001_import_jobs.sql
-- Phase 1A: chunked queue for bulk contact imports.
-- Reuses existing upload_jobs table, adds new columns: r2_key, queued_at, finished_at.
-- Adds import_jobs as a dedicated v2 table; migration is additive only.

CREATE TABLE IF NOT EXISTS _migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  total_rows INTEGER DEFAULT 0,
  processed_rows INTEGER DEFAULT 0,
  accepted INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0,
  errors_json TEXT,
  r2_key TEXT NOT NULL,
  filename TEXT,
  size_bytes INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_tenant ON import_jobs(tenant_id, status, created_at DESC);

INSERT OR IGNORE INTO _migrations (filename) VALUES ('0001_import_jobs.sql');
