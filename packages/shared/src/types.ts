// packages/shared/src/types.ts
// Shared type definitions for all ICRV workers

// ─── Environment — bound to every worker via wrangler.toml ───────────────────

export interface BaseEnv {
  // D1
  DB: D1Database;

  // KV
  KV_CONFIG:  KVNamespace;
  KV_OAUTH:   KVNamespace;
  KV_RATE:    KVNamespace;
  KV_IDEMP:   KVNamespace;
  KV_TRACK:   KVNamespace;

  // R2
  R2_MEDIA:       R2Bucket;
  R2_UPLOADS:     R2Bucket;
  R2_EXPORTS:     R2Bucket;
  R2_TRANSCRIPTS: R2Bucket;
  R2_EVIDENCE:    R2Bucket;

  // Queues (producers — every worker can produce)
  Q_EMAIL_OUT:      Queue<EmailOutPayload>;
  Q_EMAIL_IN:       Queue<InboundEmailPayload>;
  Q_WA_OUT:         Queue<WaOutPayload>;
  Q_WA_IN:          Queue<InboundWaPayload>;
  Q_VOICE_POSTCALL: Queue<VoiceOutPayload | VoicePostcallPayload>;
  Q_AGENT:          Queue<AgentJobPayload>;
  Q_RETRY:          Queue<RetryPayload>;
  Q_DLQ:            Queue<QueuePayload>;

  // DOs (all classes registered in icrv-api except AgentSessionDO which is in icrv-agent)
  VOICE_SESSION_DO:    DurableObjectNamespace;
  CAMPAIGN_DO:         DurableObjectNamespace;
  CONTACT_INBOX_DO:    DurableObjectNamespace;
  AGENT_SESSION_DO:    DurableObjectNamespace;
  OAUTH_DO:            DurableObjectNamespace;

  // Secrets — present in every worker that needs envelope encryption
  MASTER_KEK: string;

  // Telemetry (PR 4) — empty string means Sentry stays uninitialised on that
  // worker; @sentry/cloudflare's withSentry() then becomes a no-op wrapper.
  SENTRY_DSN?: string;
  ENVIRONMENT?: string;   // 'production' | 'preview' | 'dev' — falls back to 'production'
}

// ─── Auth headers injected by icrv-api into service-binding requests ─────────

export interface AuthHeaders {
  'X-Tenant-ID': string;
  'X-User-ID':   string;
  'X-User-Role': 'admin' | 'operator' | 'viewer';
}

// ─── Queue payloads ──────────────────────────────────────────────────────────

export interface QueuePayload {
  id:          string;
  tenant_id:   string;
  attempt:     number;
  enqueued_at?: string;
  type?:       string;
  dlq_reason?: string;
  dlq_at?:     string;
}

export interface RetryPayload extends QueuePayload {
  type:             'retry';
  original_queue:   string;
  original_payload: QueuePayload;
  next_attempt_at:  string;
  max_attempts:     number;
}

// ─── Email out ───────────────────────────────────────────────────────────────

export interface EmailOutPayload extends QueuePayload {
  type:            'email_out';
  message_id:      string;
  contact_id:      string;
  campaign_id?:    string;
  step_id?:        string;
  oauth_token_id:  string;
  to_email:        string;
  to_name?:        string;
  from_email:      string;
  from_name?:      string;
  subject:         string;
  html_body:       string;
  text_body?:      string;
  reply_to?:       string;
  tracking_domain: string;
}

// ─── Email in (inbound Gmail push) ───────────────────────────────────────────

export interface InboundEmailPayload extends QueuePayload {
  type:            'email_in';
  raw_payload_uri: string;       // R2 path
  history_id?:     string;
  oauth_token_id?: string;
}

// ─── WhatsApp ────────────────────────────────────────────────────────────────

export interface WaTemplateParameter {
  type:      'text' | 'image' | 'document' | 'video' | 'currency' | 'date_time';
  text?:     string;
  image?:    { link: string };
  document?: { link: string; filename?: string };
  video?:    { link: string };
  currency?: { fallback_value: string; code: string; amount_1000: number };
  date_time?: { fallback_value: string };
}

export interface WaTemplateComponent {
  type:        'header' | 'body' | 'button';
  parameters:  WaTemplateParameter[];
  sub_type?:   'url' | 'quick_reply';
  index?:      number;
}

export interface WaOutPayload extends QueuePayload {
  type:                'wa_out';
  message_id:          string;
  contact_id:          string;
  campaign_id?:        string;
  step_id?:            string;
  credential_id:       string;
  to_phone_e164:       string;
  template_name:       string;
  template_language:   string;
  template_components: WaTemplateComponent[];
}

export interface InboundWaPayload extends QueuePayload {
  type:            'wa_in';
  raw_payload_uri: string;
}

// ─── Voice ───────────────────────────────────────────────────────────────────

export interface VoiceOutPayload extends QueuePayload {
  type:              'voice_out';
  call_log_id:       string;
  contact_id:        string;
  campaign_id?:      string;
  rc_credential_id:  string;
  el_credential_id:  string;
  el_agent_id:       string;
  to_phone_e164:     string;
  from_phone_e164:   string;
  correlation_id:    string;
}

export interface VoicePostcallPayload extends QueuePayload {
  type:                'voice_postcall';
  call_log_id:         string;
  contact_id:          string;
  campaign_id?:        string;
  rc_credential_id:    string;
  el_credential_id:    string;
  rc_call_id:          string;
  el_conversation_id?: string;
  correlation_id:      string;
}

// ─── Agent jobs ──────────────────────────────────────────────────────────────

export interface AgentJobPayload extends QueuePayload {
  type:           'agent_job' | 'agent_dispatch';
  run_id:         string;
  contact_id?:    string;
  campaign_id?:   string;
  trigger_type?:  string;
  trigger_payload?: Record<string, unknown>;
}

// ─── Decrypted credential shapes (transient — never persisted) ───────────────

export interface WaCredentials {
  access_token:    string;
  phone_number_id: string;
  business_id:     string;
}

export interface RcCredentials {
  jwt:           string;
  client_id:     string;
  client_secret: string;
  server:        string;
}

export interface ElCredentials {
  api_key: string;
}

export interface GmailRefreshCredentials {
  refresh_token:  string;
  client_id:      string;
  client_secret:  string;
}
