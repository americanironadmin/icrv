// workers/icrv-agent/src/dispatcher.ts
// Dispatches a single approved AgentAction to the correct downstream queue.
// Every dispatch:
//   1. Creates an agent_actions row with status='pending'
//   2. Pre-creates the channel-specific record (messages / call_logs)
//   3. Enqueues the typed payload
//   4. Updates agent_actions.status = 'executed'
//
// The consumer checks agent_actions.status before actually sending —
// this means an operator can still revoke an action between dispatch and delivery.

import type {
  BaseEnv,
  EmailOutPayload,
  WaOutPayload,
  WaTemplateComponent,
  VoiceOutPayload,
} from '@icrv/shared/types';
import type { AgentAction } from './llm-planner';
import { uuidv4, nowISO } from '@icrv/shared/crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch context (resolved before calling dispatcher)
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailDispatchContext {
  oauth_token_id:  string; // oauth_tokens.id for Gmail account
  to_email:        string;
  to_name:         string;
  from_email:      string;
  from_name:       string;
  tracking_domain: string; // e.g. 'hooks.icrv.app'
}

export interface WhatsAppDispatchContext {
  credential_id:  string; // api_credentials.id (provider=whatsapp)
  to_phone_e164:  string;
}

export interface VoiceDispatchContext {
  rc_credential_id: string; // api_credentials.id (provider=ringcentral)
  el_credential_id: string; // api_credentials.id (provider=elevenlabs)
  el_agent_id:      string; // ElevenLabs agent ID configured for this tenant/campaign
  to_phone_e164:    string;
  from_phone_e164:  string; // RC outbound caller-ID
}

export interface DispatchContext {
  tenant_id:    string;
  contact_id:   string;
  campaign_id?: string;
  run_id:       string;
  action_index: number; // 0-based index of action within the run
  email?:       EmailDispatchContext;
  whatsapp?:    WhatsAppDispatchContext;
  voice?:       VoiceDispatchContext;
}

export interface DispatchResult {
  action_id:   string;
  status:      'executed' | 'skipped_no_channel' | 'noop';
  message_id?: string;  // messages.id or call_logs.id
  queue_used?: string;
  note?:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dispatch function
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchAction(
  action:  AgentAction,
  ctx:     DispatchContext,
  env:     BaseEnv,
): Promise<DispatchResult> {
  const actionId = uuidv4();
  const now      = nowISO();

  // ── Pre-create agent_actions row ─────────────────────────────────────────
  await env.DB.prepare(
    `INSERT INTO agent_actions
       (id, run_id, tenant_id, contact_id, action_type, channel, payload,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    actionId,
    ctx.run_id,
    ctx.tenant_id,
    ctx.contact_id,
    action.type,
    action.channel ?? null,
    JSON.stringify(action),
    now,
    now,
  ).run();

  // ── Route by action type ─────────────────────────────────────────────────
  let result: DispatchResult;

  switch (action.type) {

    case 'send_email': {
      result = await dispatchEmail(action, ctx, env, actionId, now);
      break;
    }

    case 'send_whatsapp': {
      result = await dispatchWhatsApp(action, ctx, env, actionId, now);
      break;
    }

    case 'place_call': {
      result = await dispatchVoiceCall(action, ctx, env, actionId, now);
      break;
    }

    case 'add_tag': {
      result = await dispatchAddTag(action, ctx, env, actionId, now);
      break;
    }

    case 'escalate_to_human': {
      // Status update happens on agent_runs in the caller; here just mark action executed
      await setActionStatus(env, actionId, 'executed', 'escalated');
      result = { action_id: actionId, status: 'executed', note: 'human_review_required' };
      break;
    }

    case 'stop_sequence': {
      result = await dispatchStopSequence(action, ctx, env, actionId, now);
      break;
    }

    case 'wait': {
      // No queue dispatch; follow-up scheduling handled by index.ts
      await setActionStatus(env, actionId, 'executed', 'deferred');
      result = { action_id: actionId, status: 'noop', note: `wait_${action.wait_hours}h` };
      break;
    }

    default: {
      await setActionStatus(env, actionId, 'executed', 'unknown_action');
      result = { action_id: actionId, status: 'noop', note: 'unknown_action_type' };
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel dispatchers
// ─────────────────────────────────────────────────────────────────────────────

async function dispatchEmail(
  action:   AgentAction,
  ctx:      DispatchContext,
  env:      BaseEnv,
  actionId: string,
  now:      string,
): Promise<DispatchResult> {
  if (!ctx.email) {
    await setActionStatus(env, actionId, 'skipped_no_channel', 'no_email_context');
    return { action_id: actionId, status: 'skipped_no_channel', note: 'no_email_context' };
  }
  if (!action.content?.subject || !action.content?.body_html) {
    await setActionStatus(env, actionId, 'skipped_no_channel', 'missing_email_content');
    return { action_id: actionId, status: 'skipped_no_channel', note: 'missing_email_content' };
  }

  const messageId = uuidv4();

  // Pre-create messages row
  await env.DB.prepare(
    `INSERT INTO messages
       (id, tenant_id, contact_id, campaign_id, channel, direction,
        subject, body_html, status, agent_run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'email', 'outbound', ?, ?, 'queued', ?, ?, ?)`,
  ).bind(
    messageId,
    ctx.tenant_id,
    ctx.contact_id,
    ctx.campaign_id ?? null,
    action.content.subject,
    action.content.body_html,
    ctx.run_id,
    now,
    now,
  ).run();

  const payload: EmailOutPayload = {
    id:              uuidv4(),
    type:            'email_out',
    tenant_id:       ctx.tenant_id,
    attempt:         1,
    enqueued_at:     now,
    message_id:      messageId,
    contact_id:      ctx.contact_id,
    campaign_id:     ctx.campaign_id,
    oauth_token_id:  ctx.email.oauth_token_id,
    to_email:        ctx.email.to_email,
    to_name:         ctx.email.to_name,
    from_email:      ctx.email.from_email,
    from_name:       ctx.email.from_name,
    subject:         action.content.subject,
    html_body:       action.content.body_html,
    text_body:       action.content.body_text ?? stripHtml(action.content.body_html),
    tracking_domain: ctx.email.tracking_domain,
  };

  await env.Q_EMAIL_OUT.send(payload);
  await setActionStatus(env, actionId, 'executed', messageId);

  return { action_id: actionId, status: 'executed', message_id: messageId, queue_used: 'icrv-email-out' };
}

async function dispatchWhatsApp(
  action:   AgentAction,
  ctx:      DispatchContext,
  env:      BaseEnv,
  actionId: string,
  now:      string,
): Promise<DispatchResult> {
  if (!ctx.whatsapp) {
    await setActionStatus(env, actionId, 'skipped_no_channel', 'no_whatsapp_context');
    return { action_id: actionId, status: 'skipped_no_channel', note: 'no_whatsapp_context' };
  }
  if (!action.content?.template_name) {
    await setActionStatus(env, actionId, 'skipped_no_channel', 'missing_template_name');
    return { action_id: actionId, status: 'skipped_no_channel', note: 'missing_template_name' };
  }

  const messageId = uuidv4();

  await env.DB.prepare(
    `INSERT INTO messages
       (id, tenant_id, contact_id, campaign_id, channel, direction,
        status, agent_run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'whatsapp', 'outbound', 'queued', ?, ?, ?)`,
  ).bind(
    messageId,
    ctx.tenant_id,
    ctx.contact_id,
    ctx.campaign_id ?? null,
    ctx.run_id,
    now,
    now,
  ).run();

  const payload: WaOutPayload = {
    id:                  uuidv4(),
    type:                'wa_out',
    tenant_id:           ctx.tenant_id,
    attempt:             1,
    enqueued_at:         now,
    message_id:          messageId,
    contact_id:          ctx.contact_id,
    campaign_id:         ctx.campaign_id,
    credential_id:       ctx.whatsapp.credential_id,
    to_phone_e164:       ctx.whatsapp.to_phone_e164,
    template_name:       action.content.template_name,
    template_language:   action.content.template_language ?? 'en_US',
    template_components: (action.content.template_components ?? []) as WaTemplateComponent[],
  };

  await env.Q_WA_OUT.send(payload);
  await setActionStatus(env, actionId, 'executed', messageId);

  return { action_id: actionId, status: 'executed', message_id: messageId, queue_used: 'icrv-wa-out' };
}

async function dispatchVoiceCall(
  action:   AgentAction,
  ctx:      DispatchContext,
  env:      BaseEnv,
  actionId: string,
  now:      string,
): Promise<DispatchResult> {
  if (!ctx.voice) {
    await setActionStatus(env, actionId, 'skipped_no_channel', 'no_voice_context');
    return { action_id: actionId, status: 'skipped_no_channel', note: 'no_voice_context' };
  }

  const callLogId      = uuidv4();
  const correlationId  = uuidv4();

  await env.DB.prepare(
    `INSERT INTO call_logs
       (id, tenant_id, contact_id, campaign_id, direction,
        status, correlation_id, agent_run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'outbound', 'queued', ?, ?, ?, ?)`,
  ).bind(
    callLogId,
    ctx.tenant_id,
    ctx.contact_id,
    ctx.campaign_id ?? null,
    correlationId,
    ctx.run_id,
    now,
    now,
  ).run();

  // Store LLM-generated call script so VoiceSessionDO can inject it as the EL agent override
  await env.KV_CONFIG.put(
    `call_script:${correlationId}`,
    action.content?.call_script ?? '',
    { expirationTtl: 3600 }, // 1 h — call must start within this window
  );

  const payload: VoiceOutPayload = {
    id:               uuidv4(),
    type:             'voice_out',
    tenant_id:        ctx.tenant_id,
    attempt:          1,
    enqueued_at:      now,
    call_log_id:      callLogId,
    contact_id:       ctx.contact_id,
    campaign_id:      ctx.campaign_id,
    rc_credential_id: ctx.voice.rc_credential_id,
    el_credential_id: ctx.voice.el_credential_id,
    el_agent_id:      ctx.voice.el_agent_id,
    to_phone_e164:    ctx.voice.to_phone_e164,
    from_phone_e164:  ctx.voice.from_phone_e164,
    correlation_id:   correlationId,
  };

  // Voice uses Q_VOICE_POSTCALL binding for outbound jobs per architecture
  // The consumer distinguishes voice_out from voice_postcall by payload.type
  await env.Q_VOICE_POSTCALL.send(payload);
  await setActionStatus(env, actionId, 'executed', callLogId);

  return { action_id: actionId, status: 'executed', message_id: callLogId, queue_used: 'icrv-voice' };
}

async function dispatchAddTag(
  action:   AgentAction,
  ctx:      DispatchContext,
  env:      BaseEnv,
  actionId: string,
  now:      string,
): Promise<DispatchResult> {
  const tag = action.tag;
  if (!tag) {
    await setActionStatus(env, actionId, 'skipped_no_channel', 'missing_tag');
    return { action_id: actionId, status: 'skipped_no_channel', note: 'missing_tag' };
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO contact_tags
       (id, contact_id, tag, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(uuidv4(), ctx.contact_id, tag, ctx.tenant_id, now).run();

  await setActionStatus(env, actionId, 'executed', `tag:${tag}`);
  return { action_id: actionId, status: 'executed', note: `tagged:${tag}` };
}

async function dispatchStopSequence(
  _action:  AgentAction,
  ctx:      DispatchContext,
  env:      BaseEnv,
  actionId: string,
  now:      string,
): Promise<DispatchResult> {
  if (ctx.campaign_id) {
    await env.DB.prepare(
      `UPDATE campaign_enrollments
       SET status='stopped', stopped_at=?, updated_at=?
       WHERE contact_id=? AND campaign_id=? AND status='active'`,
    ).bind(now, now, ctx.contact_id, ctx.campaign_id).run();
  }

  await setActionStatus(env, actionId, 'executed', 'sequence_stopped');
  return { action_id: actionId, status: 'executed', note: 'sequence_stopped' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function setActionStatus(
  env:       BaseEnv,
  actionId:  string,
  status:    string,
  resultRef: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE agent_actions
     SET status=?, result_ref=?, updated_at=datetime('now')
     WHERE id=?`,
  ).bind(status, resultRef, actionId).run();
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
