-- 0006_consent_requests.sql
-- v2.6: track consent-request lifecycle on the existing consents row.
--
--   requested_at   ISO timestamp when we sent the consent-request email
--   request_token  HMAC-signed token embedded in the consent link (uniquely
--                  binds back to (tenant, contact, channel))
--   granted_at     timestamp the recipient clicked Accept (or Decline → revoked)
--   request_count  how many times we've sent a consent request
--
-- Derived UI states:
--   granted        = consent_state='granted'
--   revoked        = consent_state='revoked'
--   pending        = consent_state='none' AND requested_at IS NOT NULL
--   never_requested= no consents row OR (consent_state='none' AND requested_at IS NULL)

ALTER TABLE consents ADD COLUMN requested_at  TEXT;
ALTER TABLE consents ADD COLUMN request_token TEXT;
ALTER TABLE consents ADD COLUMN granted_at    TEXT;
ALTER TABLE consents ADD COLUMN request_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_consents_request_token ON consents(request_token);
CREATE INDEX IF NOT EXISTS idx_consents_pending       ON consents(tenant_id, channel, requested_at);

INSERT OR IGNORE INTO _migrations (filename) VALUES ('0006_consent_requests.sql');
