-- 0004_lead_scores.sql — Phase 4 lead intelligence.

CREATE TABLE IF NOT EXISTS lead_scores (
  contact_id        TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  score             INTEGER NOT NULL,
  category          TEXT NOT NULL,
  engagement_score  REAL,
  demographic_score REAL,
  behavioral_score  REAL,
  tag_score         REAL,
  last_calculated   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_scores_tenant_score ON lead_scores(tenant_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_lead_scores_category    ON lead_scores(tenant_id, category);

-- contacts.country_code, country_name_ar, region_tier, industry, industry_ar
-- (Phase 5 Regional Outreach pulls these in too)
ALTER TABLE contacts ADD COLUMN country_code     TEXT;
ALTER TABLE contacts ADD COLUMN country_name_ar  TEXT;
ALTER TABLE contacts ADD COLUMN region_tier      TEXT;
ALTER TABLE contacts ADD COLUMN industry         TEXT;
ALTER TABLE contacts ADD COLUMN industry_ar      TEXT;

INSERT OR IGNORE INTO _migrations (filename) VALUES ('0004_lead_scores.sql');
