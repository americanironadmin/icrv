// workers/icrv-voice/src/index.ts
// Voice plane orchestrator. Three concerns:
//
//  1. RingCentral client (SIP RingOut) — exported as RingCentralClient so other
//     workers (icrv-cron, icrv-consumer) can place outbound calls. Uses
//     server-to-server JWT grant for OAuth.
//
//  2. ElevenLabs SIP outbound dispatcher — given an EL agent_id and a target
//     E.164 number, opens an outbound call leg via /v1/convai/conversations
//     with sip_phone_number_outbound, then hands the SIP termination to RC.
//
//  3. Custom LLM proxy at /llm/v1/chat/completions — OpenAI-compatible streaming
//     endpoint that ElevenLabs Conversational AI calls as its "custom LLM".
//     We translate the OpenAI request to Anthropic Messages API, stream back
//     Claude Haiku 4.5 tokens as SSE chunks. This keeps the agent fast and
//     responsive on phone calls (Haiku 4.5 is the lowest-latency Claude tier).
//
// Audio (RTP/SRTP) NEVER traverses this Worker. Only control + brain.

import type { BaseEnv, VoiceOutPayload, VoicePostcallPayload, RetryPayload } from '@icrv/shared/types';
import { uuidv4, nowISO, encryptSecret } from '@icrv/shared/crypto';
import { isDuplicate, scheduleRetry } from '@icrv/shared/queue-helpers';
import { loadRcCredentials, loadElCredentials } from '@icrv/shared/credentials';
import { RingCentralClient } from '@icrv/shared/ring-central-client';

interface VoiceEnv extends BaseEnv {
  ANTHROPIC_API_KEY:    string;
  VOICE_LLM_MODEL:      string;   // default "claude-haiku-4-5-20251001"
  VOICE_LLM_MAX_TOKENS: string;   // string in env vars; parsed

  // Bootstrap secrets — only on icrv-voice, never on icrv-api
  EL_API_KEY:           string;   // ElevenLabs API key
  EL_LLM_SHARED_SECRET: string;   // Bearer secret for our /llm/v1 endpoint
  RC_JWT:               string;   // RingCentral creds JSON: { jwt, client_id, client_secret, server }
  RC_WEBHOOK_TOKEN:     string;   // HMAC token for RC webhook verification (written to D1)
}

// ─── HTTP (callable + LLM proxy) ───────────────────────────────────────────

export default {
  async fetch(req: Request, env: VoiceEnv): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true, service: 'icrv-voice',
        voice_llm_model: env.VOICE_LLM_MODEL || 'claude-haiku-4-5-20251001',
      });
    }

    if (url.pathname === '/place-call' && req.method === 'POST') {
      const payload = await req.json() as VoiceOutPayload;
      try {
        const r = await placeCall(payload, env);
        return Response.json(r);
      } catch (err) {
        return Response.json({ error: 'place_call_failed', detail: (err as Error).message }, { status: 502 });
      }
    }

    // OpenAI-compatible chat completions for ElevenLabs Conversational AI custom-LLM
    // The path mimics OpenAI exactly so EL's "openai" provider works pointed at us.
    if (url.pathname === '/llm/v1/chat/completions' && req.method === 'POST') {
      return handleLlmProxy(req, env);
    }

    // ─── Bootstrap endpoint — called via service binding from icrv-api admin ──
    // Provisions EL and RC credentials into D1, creates the EL Conversational AI
    // agent, and registers the RingCentral webhook subscription.  Idempotent.
    if (url.pathname === '/bootstrap' && req.method === 'POST') {
      return handleBootstrap(req, env);
    }

    return new Response('not_found', { status: 404 });
  },

  async queue(batch: MessageBatch<VoiceOutPayload | VoicePostcallPayload | RetryPayload>, env: VoiceEnv): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body;
        const orig = body.type === 'retry' ? (body as RetryPayload).original_payload : body;

        if (orig.type === 'voice_out') {
          if (await isDuplicate(env, orig.id)) { msg.ack(); continue; }
          await placeCall(orig as VoiceOutPayload, env);
          msg.ack();
          continue;
        }
        if (orig.type === 'voice_postcall') {
          await processPostCall(orig as VoicePostcallPayload, env);
          msg.ack();
          continue;
        }
        msg.ack();
      } catch (err) {
        const orig = msg.body.type === 'retry' ? (msg.body as RetryPayload).original_payload : msg.body;
        // voice_out failures retry to the same postcall queue (icrv-voice consumes both types)
        // The consumer differentiates via payload.type field ('voice_out' vs 'voice_postcall')
        await scheduleRetry(env, 'icrv-voice-postcall', orig, (err as Error).message);
        msg.ack();
      }
    }
  },
} satisfies ExportedHandler<VoiceEnv, VoiceOutPayload | VoicePostcallPayload | RetryPayload>;

// ─── Place call ────────────────────────────────────────────────────────────

async function placeCall(p: VoiceOutPayload, env: VoiceEnv): Promise<{ ok: true; rc_session_id?: string; el_conversation_id?: string }> {
  // Init VoiceSessionDO so webhooks can find it
  const stub = env.VOICE_SESSION_DO.get(env.VOICE_SESSION_DO.idFromName(p.correlation_id));
  await stub.fetch('http://do/init', {
    method: 'POST',
    body: JSON.stringify({
      correlation_id: p.correlation_id, tenant_id: p.tenant_id,
      call_log_id: p.call_log_id,
      rc_credential_id: p.rc_credential_id, el_credential_id: p.el_credential_id,
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  await env.DB.prepare(`UPDATE call_logs SET status='ringing', started_at=?, updated_at=? WHERE id=?`)
    .bind(nowISO(), nowISO(), p.call_log_id).run();

  const rc = await RingCentralClient.fromCredential(p.rc_credential_id, env);
  const el = await loadElCredentials(env, p.el_credential_id);

  // Step 1 — start an ElevenLabs outbound conversation. EL returns a SIP URI we
  // INVITE to from RingCentral. The X-ICRV-Session header carries our
  // correlation_id so EL webhooks bind to the right VoiceSessionDO.
  const callScript = await env.KV_CONFIG.get(`call_script:${p.correlation_id}`);
  // EL Conversational AI requires agent_phone_number_id (a phone provisioned in
  // the agent's Phone Numbers section). Read it from EL credential metadata,
  // settable via PUT /v1/admin/integrations/elevenlabs from the Settings UI.
  const agentPhoneNumberId = el.metadata['phone_number_id'] ?? '';
  if (!agentPhoneNumberId) {
    await env.DB.prepare(`UPDATE call_logs SET status='failed', outcome=?, updated_at=? WHERE id=?`)
      .bind('elevenlabs:agent_phone_number_id_not_configured', nowISO(), p.call_log_id).run();
    throw new Error('elevenlabs_agent_phone_number_id_not_configured: configure in Settings → Voice');
  }

  // EL exposes provider-specific outbound-call endpoints:
  //   /v1/convai/sip-trunk/outbound-call  — SIP trunk numbers only
  //   /v1/convai/twilio/outbound-call     — Twilio numbers only
  // We try Twilio first if metadata.provider==='twilio', else SIP trunk.
  // If the first attempt fails with invalid_provider, fall back to the other.
  const elProvider = (el.metadata['provider'] ?? 'twilio').toLowerCase();
  const sipUrl    = 'https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call';
  const twilioUrl = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';
  let elUrl = elProvider === 'sip_trunk' || elProvider === 'sip-trunk' ? sipUrl : twilioUrl;

  let elRes = await fetch(elUrl, {
    method: 'POST',
    headers: { 'xi-api-key': el.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: p.el_agent_id,
      agent_phone_number_id: agentPhoneNumberId,
      to_number: p.to_phone_e164,
      from_number: p.from_phone_e164,
      conversation_initiation_client_data: {
        custom_llm_extra_body: {
          // Tagging the LLM request so our /llm/v1/chat/completions can correlate
          icrv_correlation_id: p.correlation_id,
          icrv_tenant_id:      p.tenant_id,
          icrv_call_script:    callScript ?? '',
        },
        dynamic_variables: {
          correlation_id: p.correlation_id,
        },
      },
      metadata: { correlation_id: p.correlation_id, call_log_id: p.call_log_id },
    }),
  });
  if (!elRes.ok) {
    const t = await elRes.text();
    await env.DB.prepare(`UPDATE call_logs SET status='failed', outcome=?, updated_at=? WHERE id=?`)
      .bind(`elevenlabs:${t.slice(0,200)}`, nowISO(), p.call_log_id).run();
    throw new Error(`elevenlabs_${elRes.status}:${t.slice(0,200)}`);
  }
  const elData = await elRes.json() as { conversation_id?: string; sip_uri?: string; success?: boolean };
  await stub.fetch('http://do/event', {
    method: 'POST',
    body: JSON.stringify({ el_conversation_id: elData.conversation_id ?? null }),
    headers: { 'Content-Type': 'application/json' },
  });

  // Step 2 — RingCentral RingOut bridges the destination number to EL's SIP URI.
  // RC returns immediately; status changes flow via /hooks/ringcentral.
  const rcSession = await rc.placeRingOut({
    to:                  p.to_phone_e164,
    from:                p.from_phone_e164,
    correlationId:       p.correlation_id,
    elSipUri:            elData.sip_uri,
  });

  await env.DB.prepare(
    `UPDATE call_logs SET rc_session_id=?, el_conversation_id=?, updated_at=? WHERE id=?`,
  ).bind(rcSession.session_id ?? null, elData.conversation_id ?? null, nowISO(), p.call_log_id).run();
  await stub.fetch('http://do/event', {
    method: 'POST',
    body: JSON.stringify({ rc_session_id: rcSession.session_id ?? null }),
    headers: { 'Content-Type': 'application/json' },
  });

  return { ok: true, rc_session_id: rcSession.session_id, el_conversation_id: elData.conversation_id };
}

// ─── Post-call ─────────────────────────────────────────────────────────────

async function processPostCall(p: VoicePostcallPayload, env: VoiceEnv): Promise<void> {
  const call = await env.DB.prepare(
    `SELECT id, tenant_id, contact_id, rc_session_id FROM call_logs WHERE id = ?`,
  ).bind(p.call_log_id).first<{ id: string; tenant_id: string; contact_id: string; rc_session_id?: string }>();
  if (!call) return;

  // Pull recording from RingCentral if available (RC stores up to 90 days)
  try {
    if (call.rc_session_id) {
      const cred = await env.DB.prepare(
        `SELECT id FROM api_credentials WHERE tenant_id = ? AND provider='ringcentral' AND is_active=1 LIMIT 1`,
      ).bind(call.tenant_id).first<{ id: string }>();
      if (cred) {
        const rc = await RingCentralClient.fromCredential(cred.id, env);
        const recording = await rc.getRecordingForSession(call.rc_session_id);
        if (recording) {
          const r2Path = `recordings/${call.tenant_id}/${call.id}.${recording.contentType.includes('mpeg') ? 'mp3' : 'wav'}`;
          await env.R2_MEDIA.put(r2Path, recording.body, { httpMetadata: { contentType: recording.contentType } });
          await env.DB.prepare(`UPDATE call_logs SET recording_uri=?, updated_at=? WHERE id=?`)
            .bind(r2Path, nowISO(), call.id).run();
        }
      }
    }
  } catch (err) {
    console.warn('postcall_recording_fetch', (err as Error).message);
  }

  // Trigger an agent run with the post-call summary
  await env.Q_AGENT.send({
    id: uuidv4(), type: 'agent_job', tenant_id: call.tenant_id, attempt: 1,
    enqueued_at: nowISO(), run_id: '', contact_id: call.contact_id,
    trigger_type: 'post_call', trigger_payload: { call_log_id: call.id, correlation_id: p.correlation_id },
  });
}

// ─── Bootstrap provisioning ─────────────────────────────────────────────────
// Idempotently provisions EL + RC credentials into api_credentials, creates
// the ElevenLabs Conversational AI agent, and registers the RC webhook.
// Called via service binding from icrv-api POST /v1/admin/bootstrap-credentials.

async function handleBootstrap(req: Request, env: VoiceEnv): Promise<Response> {
  let tenantId: string;
  try {
    const body = await req.json() as { tenant_id?: string };
    tenantId = body.tenant_id ?? '';
    if (!tenantId) throw new Error('missing tenant_id');
  } catch (err) {
    return Response.json({ error: 'bad_request', detail: (err as Error).message }, { status: 400 });
  }

  const results: Record<string, unknown> = {};

  // ── 1. ElevenLabs credential ─────────────────────────────────────────────
  const existingEl = await env.DB.prepare(
    `SELECT id FROM api_credentials WHERE tenant_id=? AND provider='elevenlabs' AND is_active=1 LIMIT 1`,
  ).bind(tenantId).first<{ id: string }>();

  let elCredId: string;
  if (existingEl) {
    elCredId = existingEl.id;
    results.el_credential = { status: 'already_exists', id: elCredId };
  } else {
    // Store as JSON so loadElCredentials can JSON.parse it correctly.
    const enc = await encryptSecret(JSON.stringify({ api_key: env.EL_API_KEY }), env.MASTER_KEK, tenantId, 1);
    elCredId = uuidv4();
    const now = nowISO();
    await env.DB.prepare(
      `INSERT INTO api_credentials (id,tenant_id,provider,label,cipher_text,iv,auth_tag,key_version,is_active,created_at,updated_at)
       VALUES (?,?,'elevenlabs','ElevenLabs API Key',?,?,?,?,1,?,?)`,
    ).bind(elCredId, tenantId, enc.cipher_text, enc.iv, enc.auth_tag, enc.key_version, now, now).run();
    results.el_credential = { status: 'created', id: elCredId };
  }

  // ── 2. Create / retrieve ElevenLabs Conversational AI agent ──────────────
  const kvAgentKey = `el_agent_id:${tenantId}`;
  const existingAgentId = await env.KV_CONFIG.get(kvAgentKey);

  if (existingAgentId) {
    results.el_agent = { status: 'already_exists', agent_id: existingAgentId };
  } else {
    // LLM proxy URL for this deployment
    const llmProxyUrl = 'https://icrv-voice.americanironadmin.workers.dev/llm/v1/chat/completions';

    const agentBody = {
      name: 'ICRV Sales Agent',
      conversation_config: {
        agent: {
          prompt: {
            prompt: 'You are a professional sales agent for Iron Customer Reach. Be concise, helpful, and drive toward a meeting or next step.',
          },
          language: 'en',
        },
        llm: {
          model: 'claude-haiku-4-5-20251001',
          provider: 'custom-llm',
          custom_llm_extra_body: {},
          server: {
            url: llmProxyUrl,
            timeout_secs: 30,
          },
          authorization: {
            type: 'bearer',
            bearer_token: env.EL_LLM_SHARED_SECRET,
          },
        },
        stt: {
          model: 'nova-3',
          provider: 'deepgram',
        },
        tts: {
          model_id: 'eleven_turbo_v2',
          voice_id: 'EXAVITQu4vr4xnSDxMaL', // "Sarah" — neutral professional voice
        },
        turn: {
          turn_timeout: 10,
          mode: 'turn',
        },
      },
      platform_settings: {
        auth: {
          enable_auth: false,
        },
      },
    };

    const elRes = await fetch('https://api.elevenlabs.io/v1/convai/agents/create', {
      method: 'POST',
      headers: {
        'xi-api-key': env.EL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(agentBody),
    });

    if (!elRes.ok) {
      const errText = await elRes.text();
      console.error('[bootstrap] EL agent create failed', elRes.status, errText);
      results.el_agent = { status: 'error', code: elRes.status, detail: errText.slice(0, 300) };
    } else {
      const agentData = await elRes.json() as { agent_id?: string };
      const agentId = agentData.agent_id ?? '';
      if (agentId) {
        await env.KV_CONFIG.put(kvAgentKey, agentId);
        results.el_agent = { status: 'created', agent_id: agentId };
      } else {
        results.el_agent = { status: 'error', detail: 'no agent_id in response', raw: agentData };
      }
    }
  }

  // ── 3. RingCentral credential ─────────────────────────────────────────────
  const existingRc = await env.DB.prepare(
    `SELECT id FROM api_credentials WHERE tenant_id=? AND provider='ringcentral' AND is_active=1 LIMIT 1`,
  ).bind(tenantId).first<{ id: string }>();

  let rcCredId: string;
  if (existingRc) {
    rcCredId = existingRc.id;
    results.rc_credential = { status: 'already_exists', id: rcCredId };
  } else {
    // RC_JWT is stored as JSON: { jwt, client_id, client_secret, server }
    // Fall back to treating it as a plain JWT string if not JSON
    let rcPayload: string;
    try {
      const parsed = JSON.parse(env.RC_JWT);
      rcPayload = JSON.stringify(parsed); // normalise
    } catch {
      rcPayload = JSON.stringify({
        jwt: env.RC_JWT,
        client_id: '',
        client_secret: '',
        server: 'https://platform.ringcentral.com',
      });
    }
    const enc = await encryptSecret(rcPayload, env.MASTER_KEK, tenantId, 1);
    rcCredId = uuidv4();
    const now = nowISO();
    await env.DB.prepare(
      `INSERT INTO api_credentials (id,tenant_id,provider,label,cipher_text,iv,auth_tag,key_version,is_active,created_at,updated_at)
       VALUES (?,?,'ringcentral','RingCentral JWT',?,?,?,?,1,?,?)`,
    ).bind(rcCredId, tenantId, enc.cipher_text, enc.iv, enc.auth_tag, enc.key_version, now, now).run();
    results.rc_credential = { status: 'created', id: rcCredId };
  }

  // ── 4. RingCentral webhook subscription ─────────────────────────────────
  const kvWebhookKey = `rc_webhook_id:${tenantId}`;
  const existingWebhookId = await env.KV_CONFIG.get(kvWebhookKey);

  if (existingWebhookId) {
    results.rc_webhook = { status: 'already_exists', subscription_id: existingWebhookId };
  } else {
    // We need client_id + client_secret to get an access token for subscription management
    let rcCreds: { jwt: string; client_id: string; client_secret: string; server: string };
    try {
      rcCreds = JSON.parse(env.RC_JWT);
    } catch {
      rcCreds = { jwt: env.RC_JWT, client_id: '', client_secret: '', server: 'https://platform.ringcentral.com' };
    }

    if (!rcCreds.client_id || !rcCreds.client_secret) {
      results.rc_webhook = {
        status: 'skipped',
        reason: 'RC_JWT does not contain client_id and client_secret needed for subscription API. '
               + 'Set RC_JWT to a JSON object with jwt, client_id, client_secret, server fields '
               + 'and re-run bootstrap.',
      };
    } else {
      try {
        // Exchange JWT for access token
        const tokenRes = await fetch(`${rcCreds.server}/restapi/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(`${rcCreds.client_id}:${rcCreds.client_secret}`),
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: rcCreds.jwt,
          }),
        });
        if (!tokenRes.ok) {
          const t = await tokenRes.text();
          results.rc_webhook = { status: 'error', phase: 'token_exchange', detail: t.slice(0, 300) };
        } else {
          const tokenData = await tokenRes.json() as { access_token: string };
          // Register webhook subscription for call events
          const hookUrl = 'https://icrv-hooks.americanironadmin.workers.dev/hooks/ringcentral';
          const subRes = await fetch(`${rcCreds.server}/restapi/v1.0/subscription`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              eventFilters: [
                '/restapi/v1.0/account/~/telephony/sessions',
                '/restapi/v1.0/account/~/extension/~/telephony/sessions',
              ],
              deliveryMode: {
                transportType: 'WebHook',
                address: hookUrl,
                verificationToken: env.RC_WEBHOOK_TOKEN,
              },
              expiresIn: 630720000, // ~20 years; RC caps at subscription renewal
            }),
          });
          if (!subRes.ok) {
            const t = await subRes.text();
            results.rc_webhook = { status: 'error', phase: 'subscription_create', detail: t.slice(0, 300) };
          } else {
            const subData = await subRes.json() as { id?: string; status?: string };
            const subId = subData.id ?? '';
            if (subId) {
              await env.KV_CONFIG.put(kvWebhookKey, subId);
              results.rc_webhook = { status: 'created', subscription_id: subId, rc_status: subData.status };
            } else {
              results.rc_webhook = { status: 'error', detail: 'no subscription id in RC response', raw: subData };
            }
          }
        }
      } catch (err) {
        results.rc_webhook = { status: 'error', detail: (err as Error).message };
      }
    }
  }

  return Response.json({ ok: true, tenant_id: tenantId, results });
}

// ─── Custom LLM proxy: OpenAI chat/completions → Anthropic Haiku 4.5 ───────

interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: 'system'|'user'|'assistant'|'tool'; content: string | Array<{ type: string; text?: string }>; name?: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  // Custom field plumbed through by ElevenLabs convai_extra_body
  icrv_correlation_id?: string;
  icrv_tenant_id?: string;
  icrv_call_script?: string;
}

async function handleLlmProxy(req: Request, env: VoiceEnv): Promise<Response> {
  // ElevenLabs sends our agent's API key as a Bearer; we don't validate it
  // strictly here because the worker is reachable only via direct route bound
  // to the EL agent's custom-LLM URL config (HTTPS, plus optional Cf Access for
  // egress IP restriction). For belt-and-braces we check a shared header:
  // Validate EL LLM shared secret (set in ElevenLabs custom-LLM config as Bearer token)
  const sharedSecret = (env as VoiceEnv & { EL_LLM_SHARED_SECRET?: string }).EL_LLM_SHARED_SECRET;
  if (sharedSecret) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== sharedSecret) {
      return Response.json({ error: { message: 'unauthorized', code: 'invalid_shared_secret' } }, { status: 401 });
    }
  }

  let body: OpenAIChatRequest;
  try { body = await req.json() as OpenAIChatRequest; }
  catch { return Response.json({ error: { message: 'invalid_json' } }, { status: 400 }); }

  // Translate OpenAI ↔ Anthropic
  const sysParts = body.messages.filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : m.content.map(p => p.text ?? '').join(''));
  const baseSystem = sysParts.join('\n\n').trim();
  const callScript = (body.icrv_call_script ?? '').trim();
  const system = [baseSystem, callScript].filter(Boolean).join('\n\n');

  const anthropicMessages = body.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content
             : (m.content as Array<{ type: string; text?: string }>).map(p => p.text ?? '').join(''),
    }));

  const model = env.VOICE_LLM_MODEL || 'claude-haiku-4-5-20251001';
  const maxTokens = parseInt(env.VOICE_LLM_MAX_TOKENS || '512', 10);
  const stream = body.stream !== false; // EL convai expects streaming by default

  const anthropicReq = {
    model,
    max_tokens: maxTokens,
    temperature: body.temperature ?? 0.4,
    system: system || undefined,
    messages: anthropicMessages.length ? anthropicMessages : [{ role: 'user', content: 'Hello.' }],
    stream,
  };

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicReq),
  });

  if (!upstream.ok) {
    const t = await upstream.text();
    return Response.json(
      { error: { message: `anthropic_${upstream.status}: ${t.slice(0,200)}` } },
      { status: 502 },
    );
  }

  if (!stream) {
    const data = await upstream.json() as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
      id?: string;
    };
    const text = (data.content ?? []).map(b => b.text ?? '').join('');
    return Response.json({
      id: data.id ?? `cmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens:     data.usage?.input_tokens  ?? 0,
        completion_tokens: data.usage?.output_tokens ?? 0,
        total_tokens:      (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
    });
  }

  // ─── Stream: convert Anthropic SSE to OpenAI delta SSE ────────────────────
  const id = `chatcmpl-${uuidv4()}`;
  const created = Math.floor(Date.now() / 1000);

  const ts = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      const first = `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`;
      controller.enqueue(new TextEncoder().encode(first));
    },
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      // Anthropic emits SSE like:  event: content_block_delta\ndata: {...}\n\n
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          const evt = JSON.parse(json) as {
            type?: string;
            delta?: { type?: string; text?: string; stop_reason?: string };
            usage?: { output_tokens?: number };
          };
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            const out = `data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }],
            })}\n\n`;
            controller.enqueue(new TextEncoder().encode(out));
          } else if (evt.type === 'message_stop' || evt.type === 'message_delta') {
            const stopReason = evt.delta?.stop_reason ?? 'stop';
            const finish = stopReason === 'end_turn' ? 'stop' : (stopReason === 'max_tokens' ? 'length' : 'stop');
            const out = `data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: finish }],
            })}\n\n` + `data: [DONE]\n\n`;
            controller.enqueue(new TextEncoder().encode(out));
          }
        } catch {/* skip unparseable */}
      }
    },
  });

  upstream.body!.pipeTo(ts.writable).catch(() => {});
  return new Response(ts.readable, {
    status: 200,
    headers: {
      'Content-Type':     'text/event-stream',
      'Cache-Control':    'no-cache, no-transform',
      'Connection':       'keep-alive',
      'X-Voice-LLM':      model,
    },
  });
}

// ─── RingCentral client ────────────────────────────────────────────────────
// Server-to-server JWT grant (RC OAuth flow). Token cached in KV_OAUTH per
// credential. Provides `placeRingOut` and `getRecordingForSession`.

