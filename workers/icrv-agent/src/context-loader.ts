// workers/icrv-agent/src/context-loader.ts
// Assembles all the context the LLM planner needs in a single parallel fan-out.
// All reads use prepared statements against D1 (icrv-db).
//
// Loaded in parallel (Promise.all):
//   - contact + attributes
//   - last 20 messages across channels (chronological)
//   - consent records per channel
//   - campaign + current step + template content
//   - agent_controls rows (all four scopes)
//   - recent agent_runs for loop detection
//   - daily sent count (for max_per_day gate)
//   - unanswered sequence count
//   - channel credentials for dispatch context

import type { BaseEnv } from '@icrv/shared/types';
import type { AgentControls } from './policy-gate';
import { mergeAgentControls }  from './policy-gate';
import type { ContactContext, MessageHistoryItem, CampaignStepContext, AgentPlanInput } from './llm-planner';
import type { EmailDispatchContext, WhatsAppDispatchContext, VoiceDispatchContext, DispatchContext } from './dispatcher';

// ─────────────────────────────────────────────────────────────────────────────
// Raw D1 row shapes (match the schema in setup-d1.sh)
// ─────────────────────────────────────────────────────────────────────────────

interface ContactRow {
  id:          string;
  tenant_id:   string;
  name:        string;
  email?:      string;
  phone_e164?: string;
  whatsapp_phone_e164?: string;
  attributes_json?: string; // JSON
  tags_json?:  string;      // JSON array of strings
}

interface MessageRow {
  id:         string;
  channel:    string;
  direction:  'inbound' | 'outbound';
  subject?:   string;
  body_text?: string;
  status?:    string;
  created_at: string;
}

interface ConsentRow {
  channel:       string;
  consent_state: 'granted' | 'revoked' | 'none';
}

interface CampaignRow {
  id:    string;
  name:  string;
  goal?: string;
  tenant_persona?: string;
  tenant_goal?:    string;
}

interface CampaignStepRow {
  id:               string;
  step_index:       number;
  channel:          string;
  template_id?:     string;
  branch_logic_json?: string;
}

interface TemplateRow {
  id:           string;
  content_html?: string;
  content_text?: string;
}

interface AgentRunRow {
  id:           string;
  trigger_type: string;
  created_at:   string;
  status:       string;
}

interface CredentialRow {
  id:              string;
  provider:        string;
  metadata_json?:  string; // JSON — contains phone_number_id, agent_id etc.
}

interface OAuthTokenRow {
  id:        string;
  email?:    string;
  is_active: number;
}

interface TenantRow {
  id:             string;
  persona?:       string;
  goal?:          string;
  from_email?:    string;
  from_name?:     string;
  tracking_domain?: string;
}

interface SuppressionRow {
  contact_id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full assembled context returned by loadRunContext()
// ─────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  // LLM planner input
  planInput:         AgentPlanInput;

  // Policy gate inputs (supplementing what's in planInput.controls)
  controls:          AgentControls;
  consent_state:     Record<string, 'granted' | 'revoked' | 'none'>;
  is_suppressed:     boolean;
  sent_today:        number;
  unanswered_sequence: number;
  recent_runs:       AgentRunRow[];

  // Dispatch resolution (filled if credentials exist)
  dispatchCtx:       Omit<DispatchContext, 'run_id' | 'action_index'>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loader — all D1 reads parallelised
// ─────────────────────────────────────────────────────────────────────────────

export async function loadRunContext(
  tenantId:   string,
  contactId:  string,
  campaignId: string | undefined,
  stepId:     string | undefined,
  env:        BaseEnv,
): Promise<RunContext> {

  // ── Fan-out reads ─────────────────────────────────────────────────────────
  const [
    contactResult,
    messageResult,
    consentResult,
    campaignResult,
    controlsResult,
    runResult,
    suppressResult,
    credResult,
    tenantResult,
  ] = await Promise.all([

    // 1. Contact
    env.DB.prepare(
      `SELECT id, tenant_id, name, email, phone_e164, whatsapp_phone_e164,
              attributes_json, tags_json
       FROM contacts WHERE id = ? AND tenant_id = ?`,
    ).bind(contactId, tenantId).first<ContactRow>(),

    // 2. Last 20 messages (all channels, chronological)
    env.DB.prepare(
      `SELECT id, channel, direction, subject, body_text, status, created_at
       FROM messages
       WHERE contact_id = ? AND tenant_id = ?
       ORDER BY created_at DESC LIMIT 20`,
    ).bind(contactId, tenantId).all<MessageRow>(),

    // 3. Consent per channel
    env.DB.prepare(
      `SELECT channel, consent_state
       FROM consents WHERE contact_id = ? AND tenant_id = ?`,
    ).bind(contactId, tenantId).all<ConsentRow>(),

    // 4. Campaign + current step + template (only if campaign_id + step_id)
    campaignId
      ? env.DB.prepare(
          `SELECT c.id, c.name, c.goal, t.persona AS tenant_persona, t.goal AS tenant_goal
           FROM campaigns c
           JOIN tenants t ON t.id = c.tenant_id
           WHERE c.id = ? AND c.tenant_id = ?`,
        ).bind(campaignId, tenantId).first<CampaignRow>()
      : Promise.resolve(null),

    // 5. Agent controls (all scopes for this contact/campaign/tenant)
    env.DB.prepare(
      `SELECT scope, controls_json FROM agent_controls
       WHERE tenant_id = ?
         AND (
           (scope = 'global')
        OR (scope = 'tenant')
        OR (scope = 'campaign' AND campaign_id = ?)
        OR (scope = 'contact'  AND contact_id  = ?)
         )`,
    ).bind(tenantId, campaignId ?? '', contactId).all<{ scope: string; controls_json: string }>(),

    // 6. Recent agent_runs for loop detection + unanswered sequence
    env.DB.prepare(
      `SELECT id, trigger_type, created_at, status
       FROM agent_runs
       WHERE contact_id = ? AND tenant_id = ?
       ORDER BY created_at DESC LIMIT 10`,
    ).bind(contactId, tenantId).all<AgentRunRow>(),

    // 7. Suppression check
    env.DB.prepare(
      `SELECT contact_id FROM suppressions
       WHERE (contact_id = ? OR email = (SELECT email FROM contacts WHERE id = ?))
         AND tenant_id = ?
       LIMIT 1`,
    ).bind(contactId, contactId, tenantId).first<SuppressionRow>(),

    // 8. Active credentials for this tenant (email, whatsapp, ringcentral, elevenlabs)
    env.DB.prepare(
      `SELECT id, provider, metadata_json FROM api_credentials
       WHERE tenant_id = ? AND is_active = 1`,
    ).bind(tenantId).all<CredentialRow>(),

    // 9. Tenant defaults (persona, goal, from_email, etc.)
    env.DB.prepare(
      `SELECT id, persona, goal, from_email, from_name, tracking_domain
       FROM tenants WHERE id = ?`,
    ).bind(tenantId).first<TenantRow>(),
  ]);

  // ── Validate contact exists ───────────────────────────────────────────────
  if (!contactResult) {
    throw new Error(`contact_not_found:${contactId}`);
  }

  // ── Parse contact ─────────────────────────────────────────────────────────
  const contact: ContactContext = {
    id:                   contactResult.id,
    name:                 contactResult.name,
    email:                contactResult.email,
    phone_e164:           contactResult.phone_e164,
    whatsapp_phone_e164:  contactResult.whatsapp_phone_e164,
    attributes:           contactResult.attributes_json
      ? (JSON.parse(contactResult.attributes_json) as Record<string, string | number | boolean>)
      : {},
    tags: contactResult.tags_json
      ? (JSON.parse(contactResult.tags_json) as string[])
      : [],
  };

  // ── Parse message history ─────────────────────────────────────────────────
  const msgRows = [...(messageResult.results ?? [])].reverse(); // chronological
  const messageHistory: MessageHistoryItem[] = msgRows.map(m => ({
    channel:         m.channel,
    direction:       m.direction,
    content_summary: buildMessageSummary(m),
    created_at:      m.created_at,
    status:          m.status,
  }));

  // ── Parse consent ─────────────────────────────────────────────────────────
  const consentState: Record<string, 'granted' | 'revoked' | 'none'> = {};
  for (const row of consentResult.results ?? []) {
    consentState[row.channel] = row.consent_state;
  }

  // ── Parse agent controls ──────────────────────────────────────────────────
  const controls = mergeAgentControls(
    (controlsResult.results ?? []) as Array<{ scope: 'global' | 'tenant' | 'campaign' | 'contact'; controls_json: string }>,
  );

  // ── Daily sent count ──────────────────────────────────────────────────────
  const sentTodayResult = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM messages
     WHERE contact_id = ? AND tenant_id = ? AND direction = 'outbound'
       AND date(created_at) = date('now')`,
  ).bind(contactId, tenantId).first<{ cnt: number }>();
  const sentToday = sentTodayResult?.cnt ?? 0;

  // ── Unanswered sequence count ─────────────────────────────────────────────
  // Count consecutive outbound messages from the end of history with no inbound between them
  let unanswered = 0;
  for (let i = msgRows.length - 1; i >= 0; i--) {
    if (msgRows[i].direction === 'inbound') break;
    unanswered += 1;
  }

  // ── Step context ──────────────────────────────────────────────────────────
  let currentStep: CampaignStepContext | undefined;
  if (stepId && campaignId) {
    const stepRow = await env.DB.prepare(
      `SELECT id, step_index, channel, template_id, branch_logic_json
       FROM campaign_steps WHERE id = ? AND campaign_id = ?`,
    ).bind(stepId, campaignId).first<CampaignStepRow>();

    if (stepRow) {
      let templateContent: string | undefined;
      if (stepRow.template_id) {
        const tmpl = await env.DB.prepare(
          `SELECT id, content_html, content_text FROM templates WHERE id = ?`,
        ).bind(stepRow.template_id).first<TemplateRow>();
        templateContent = (tmpl?.content_text ?? tmpl?.content_html ?? '').slice(0, 500);
      }

      currentStep = {
        step_id:          stepRow.id,
        step_index:       stepRow.step_index,
        channel:          stepRow.channel,
        template_id:      stepRow.template_id,
        template_content: templateContent,
        branch_logic:     stepRow.branch_logic_json
          ? (JSON.parse(stepRow.branch_logic_json) as Record<string, unknown>)
          : undefined,
      };
    }
  }

  // ── Persona / goal from campaign > tenant ─────────────────────────────────
  const tenantRow = tenantResult;
  const campaignRow = campaignResult as CampaignRow | null;

  const tenantPersona = (campaignRow as { tenant_persona?: string } | null)?.tenant_persona
    ?? tenantRow?.persona
    ?? 'You are a professional sales representative.';

  const tenantGoal = (campaignRow as { tenant_goal?: string } | null)?.tenant_goal
    ?? tenantRow?.goal
    ?? 'Engage the contact and advance the sales conversation.';

  // ── Resolve dispatch credentials ──────────────────────────────────────────
  const creds = credResult.results ?? [];
  let emailCtx:     EmailDispatchContext | undefined;
  let waCtx:        WhatsAppDispatchContext | undefined;
  let voiceCtx:     VoiceDispatchContext | undefined;

  // Gmail OAuth token
  if (contact.email) {
    const oauthRow = await env.DB.prepare(
      `SELECT id, email FROM oauth_tokens
       WHERE tenant_id = ? AND provider = 'gmail' AND is_active = 1
       LIMIT 1`,
    ).bind(tenantId).first<OAuthTokenRow>();

    if (oauthRow) {
      emailCtx = {
        oauth_token_id:  oauthRow.id,
        to_email:        contact.email,
        to_name:         contact.name,
        from_email:      oauthRow.email ?? tenantRow?.from_email ?? '',
        from_name:       tenantRow?.from_name ?? '',
        tracking_domain: tenantRow?.tracking_domain ?? 'hooks.icrv.app',
      };
    }
  }

  // WhatsApp credential
  if (contact.whatsapp_phone_e164) {
    const waCred = creds.find(c => c.provider === 'whatsapp');
    if (waCred) {
      waCtx = {
        credential_id: waCred.id,
        to_phone_e164: contact.whatsapp_phone_e164,
      };
    }
  }

  // RingCentral + ElevenLabs voice
  if (contact.phone_e164) {
    const rcCred = creds.find(c => c.provider === 'ringcentral');
    const elCred = creds.find(c => c.provider === 'elevenlabs');
    if (rcCred && elCred) {
      const rcMeta = rcCred.metadata_json ? JSON.parse(rcCred.metadata_json) as Record<string, string> : {};
      const elMeta = elCred.metadata_json ? JSON.parse(elCred.metadata_json) as Record<string, string> : {};

      voiceCtx = {
        rc_credential_id: rcCred.id,
        el_credential_id: elCred.id,
        el_agent_id:      elMeta['agent_id'] ?? '',
        to_phone_e164:    contact.phone_e164,
        from_phone_e164:  rcMeta['outbound_caller_id'] ?? '',
      };
    }
  }

  // ── Assemble planInput ────────────────────────────────────────────────────
  const planInput: AgentPlanInput = {
    tenant_id:       tenantId,
    contact,
    message_history: messageHistory,
    consent_state:   consentState,
    campaign_id:     campaignId,
    campaign_name:   campaignRow?.name,
    campaign_goal:   campaignRow?.goal,
    current_step:    currentStep,
    tenant_persona:  tenantPersona,
    tenant_goal:     tenantGoal,
    controls,
    trigger_type:    '', // filled in by caller
    trigger_payload: {}, // filled in by caller
  };

  return {
    planInput,
    controls,
    consent_state:    consentState,
    is_suppressed:    !!suppressResult,
    sent_today:       sentToday,
    unanswered_sequence: unanswered,
    recent_runs:      runResult.results ?? [],
    dispatchCtx: {
      tenant_id:   tenantId,
      contact_id:  contactId,
      campaign_id: campaignId,
      email:       emailCtx,
      whatsapp:    waCtx,
      voice:       voiceCtx,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a short ≤ 300 char summary from a message row
// ─────────────────────────────────────────────────────────────────────────────

function buildMessageSummary(row: MessageRow): string {
  const parts: string[] = [];
  if (row.subject)    parts.push(`Subject: ${row.subject}`);
  if (row.body_text)  parts.push(row.body_text.slice(0, 200));
  return parts.join(' | ').slice(0, 300);
}
