-- ─────────────────────────────────────────────────────────────────────────────
-- IRON CUSTOMER REACH VMAX — D1 schema
-- Apply with:  wrangler d1 execute icrv-db --remote --file=./schema.sql
--
-- Every CREATE TABLE here corresponds to at least one prepared statement
-- somewhere in the repo. Every UNIQUE INDEX corresponds to an ON CONFLICT.
-- ─────────────────────────────────────────────────────────────────────────────

PRAGMA foreign_keys = ON;

-- ── Identity ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  persona         TEXT,
  goal            TEXT,
  from_email      TEXT,
  from_name       TEXT,
  tracking_domain TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | suspended
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'viewer',     -- admin | operator | viewer
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tenant_email ON users(tenant_id, email);

-- ── Contacts ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contacts (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  email                TEXT,
  phone_e164           TEXT,
  whatsapp_phone_e164  TEXT,
  attributes_json      TEXT,        -- JSON
  tags_json            TEXT,        -- JSON array<string>
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_contacts_tenant ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS ix_contacts_email  ON contacts(tenant_id, email);
CREATE INDEX IF NOT EXISTS ix_contacts_phone  ON contacts(tenant_id, phone_e164);

CREATE TABLE IF NOT EXISTS contact_tags (
  id         TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_contact_tags ON contact_tags(contact_id, tag);

CREATE TABLE IF NOT EXISTS consents (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  contact_id    TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,                       -- email | whatsapp | voice
  consent_state TEXT NOT NULL DEFAULT 'none',        -- granted | revoked | none
  source        TEXT,
  evidence_uri  TEXT,                                -- R2 path to proof
  recorded_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consents_unique ON consents(tenant_id, contact_id, channel);

CREATE TABLE IF NOT EXISTS suppressions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  contact_id  TEXT,
  email       TEXT,
  phone_e164  TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_suppressions_tenant ON suppressions(tenant_id);
CREATE INDEX IF NOT EXISTS ix_suppressions_email  ON suppressions(tenant_id, email);

CREATE TABLE IF NOT EXISTS unsubscribes (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  contact_id   TEXT,
  email        TEXT,
  token        TEXT NOT NULL,                       -- /u/{token}
  channel      TEXT NOT NULL DEFAULT 'email',
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_unsubscribes_token ON unsubscribes(token);

-- ── Campaigns / templates ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS templates (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  channel           TEXT NOT NULL,                  -- email | whatsapp | voice
  subject           TEXT,
  body_html         TEXT,
  body_text         TEXT,
  content_html      TEXT,                           -- legacy alias used by context-loader
  content_text      TEXT,
  template_name     TEXT,                           -- WhatsApp template name
  template_language TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  channel         TEXT NOT NULL,                    -- primary channel
  status          TEXT NOT NULL DEFAULT 'draft',    -- draft|active|paused|completed|cancelled
  goal            TEXT,
  audience_filter TEXT,                             -- JSON
  enrolled_count  INTEGER DEFAULT 0,
  sent_count      INTEGER DEFAULT 0,
  opened_count    INTEGER DEFAULT 0,
  clicked_count   INTEGER DEFAULT 0,
  replied_count   INTEGER DEFAULT 0,
  failed_count    INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  launched_at     TEXT,
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_campaigns_tenant_status ON campaigns(tenant_id, status);

CREATE TABLE IF NOT EXISTS campaign_steps (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_index        INTEGER NOT NULL,
  channel           TEXT NOT NULL,
  template_id       TEXT,
  credential_id     TEXT,
  delay_hours       INTEGER NOT NULL DEFAULT 24,
  branch_logic_json TEXT,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_steps ON campaign_steps(campaign_id, step_index);

CREATE TABLE IF NOT EXISTS campaign_enrollments (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  campaign_id         TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id          TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'active',  -- active|completed|stopped|paused
  current_step_index  INTEGER NOT NULL DEFAULT 0,
  next_step_at        TEXT NOT NULL,                   -- ISO; cron polls datetime() <= now
  enrolled_at         TEXT NOT NULL,
  completed_at        TEXT,
  stopped_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_enrollments ON campaign_enrollments(campaign_id, contact_id);
CREATE INDEX IF NOT EXISTS ix_enrollments_due ON campaign_enrollments(status, next_step_at);

-- ── Messages / events ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  campaign_id     TEXT,
  agent_run_id    TEXT,
  channel         TEXT NOT NULL,                  -- email|whatsapp|voice
  direction       TEXT NOT NULL,                  -- inbound|outbound
  subject         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  provider_msg_id TEXT,                           -- gmail message_id, wamid, etc
  status          TEXT NOT NULL DEFAULT 'queued', -- queued|sending|sent|delivered|failed|received
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS ix_messages_contact ON messages(tenant_id, contact_id, created_at);
CREATE INDEX IF NOT EXISTS ix_messages_campaign ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS ix_messages_provider ON messages(provider_msg_id);

CREATE TABLE IF NOT EXISTS message_events (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,                      -- opened | clicked | bounced | replied | delivered | read
  count       INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_message_events ON message_events(message_id, event_type);

-- ── Voice ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_logs (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  contact_id         TEXT NOT NULL,
  campaign_id        TEXT,
  agent_run_id       TEXT,
  direction          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'queued',  -- queued|ringing|connected|ended|failed|voicemail|no_answer
  correlation_id     TEXT NOT NULL,
  rc_session_id      TEXT,
  rc_party_id        TEXT,
  el_conversation_id TEXT,
  duration_seconds   INTEGER,
  outcome            TEXT,
  recording_uri      TEXT,    -- R2 path
  transcript_uri     TEXT,    -- R2 path
  started_at         TEXT,
  answered_at        TEXT,
  ended_at           TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_call_logs_correlation ON call_logs(correlation_id);
CREATE INDEX IF NOT EXISTS ix_call_logs_contact ON call_logs(tenant_id, contact_id, created_at);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id           TEXT PRIMARY KEY,
  call_log_id  TEXT NOT NULL REFERENCES call_logs(id) ON DELETE CASCADE,
  speaker      TEXT NOT NULL,         -- ai | contact
  text         TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  confidence   REAL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_transcripts_call ON call_transcripts(call_log_id, timestamp_ms);

CREATE TABLE IF NOT EXISTS voicemails (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  contact_id    TEXT,
  call_log_id   TEXT,
  audio_uri     TEXT NOT NULL,         -- R2
  transcript    TEXT,
  duration_secs INTEGER,
  received_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- ── Agent ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_runs (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  contact_id       TEXT NOT NULL,
  campaign_id      TEXT,
  trigger_type     TEXT NOT NULL,
  trigger_payload  TEXT,
  status           TEXT NOT NULL DEFAULT 'queued', -- queued|running|completed|failed|blocked_by_policy|pending|pending_human|approved|rejected|deferred|escalated
  decision_json    TEXT,
  llm_input_ref    TEXT,
  llm_output_ref   TEXT,
  cost_usd         REAL,
  duration_ms      INTEGER,
  next_run_at      TEXT,
  approved_by      TEXT,
  approved_at      TEXT,
  rejected_by      TEXT,
  rejected_at      TEXT,
  rejection_reason TEXT,
  edited_by        TEXT,
  edited_at        TEXT,
  completed_at     TEXT,
  failed_reason    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agent_runs_contact ON agent_runs(tenant_id, contact_id, created_at);
CREATE INDEX IF NOT EXISTS ix_agent_runs_status  ON agent_runs(tenant_id, status);

CREATE TABLE IF NOT EXISTS agent_actions (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL,
  contact_id        TEXT NOT NULL,
  action_type       TEXT NOT NULL,
  channel           TEXT,
  payload           TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|executed|skipped_no_channel|sent|revoked|failed
  result_ref        TEXT,
  revocation_reason TEXT,
  revoked_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_agent_actions_run ON agent_actions(run_id);

CREATE TABLE IF NOT EXISTS agent_controls (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  scope         TEXT NOT NULL,           -- global | tenant | campaign | contact
  campaign_id   TEXT,
  contact_id    TEXT,
  controls_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- ON CONFLICT in control-panel.ts requires this exact expression-index
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_controls
  ON agent_controls(tenant_id, scope, COALESCE(campaign_id, ''), COALESCE(contact_id, ''));

-- ── Audit / credentials / webhooks / uploads ─────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  actor_type    TEXT NOT NULL,                 -- operator | system | agent
  actor_id      TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  data          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_tenant_time ON audit_logs(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS api_credentials (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  provider                 TEXT NOT NULL,           -- gmail|whatsapp|ringcentral|elevenlabs
  label                    TEXT,
  cipher_text              TEXT NOT NULL,
  iv                       TEXT NOT NULL,
  auth_tag                 TEXT NOT NULL,
  key_version              INTEGER NOT NULL DEFAULT 1,
  metadata_json            TEXT,
  is_active                INTEGER NOT NULL DEFAULT 1,
  gmail_watch_expires_at   TEXT,                    -- only for provider=gmail
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_api_credentials_tenant ON api_credentials(tenant_id, provider, is_active);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  provider               TEXT NOT NULL,
  email                  TEXT,
  refresh_cipher         TEXT NOT NULL,
  refresh_iv             TEXT NOT NULL,
  refresh_auth_tag       TEXT NOT NULL,
  key_version            INTEGER NOT NULL DEFAULT 1,
  scopes                 TEXT,
  is_active              INTEGER NOT NULL DEFAULT 1,
  gmail_watch_expires_at TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_oauth_tokens_tenant ON oauth_tokens(tenant_id, provider, is_active);

CREATE TABLE IF NOT EXISTS webhooks_received (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  source       TEXT NOT NULL,    -- gmail|whatsapp|ringcentral|elevenlabs
  payload_uri  TEXT NOT NULL,    -- R2 path of raw body
  signature    TEXT,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued|processed|failed
  error        TEXT,
  received_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_webhooks_source ON webhooks_received(source, received_at);

CREATE TABLE IF NOT EXISTS upload_jobs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  user_id       TEXT,
  source_uri    TEXT NOT NULL,       -- R2 path of raw CSV
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|processing|completed|failed
  total_rows    INTEGER DEFAULT 0,
  processed     INTEGER DEFAULT 0,
  accepted      INTEGER DEFAULT 0,
  rejected      INTEGER DEFAULT 0,
  errors_json   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_upload_jobs_tenant ON upload_jobs(tenant_id, created_at);
