// workers/icrv-hooks/src/index.ts
// Public webhook + tracking + unsubscribe worker. NO Cloudflare Access in
// front of this — providers must reach it. Each handler:
//   1) verifies signature
//   2) persists raw payload to R2_EVIDENCE
//   3) records a webhooks_received row
//   4) enqueues processing
//   5) returns 200 within 50 ms
//
// Endpoints:
//   POST /hooks/gmail/push           Google Pub/Sub push (OIDC JWT)
//   GET  /hooks/whatsapp             Meta hub.challenge verification
//   POST /hooks/whatsapp             Meta WhatsApp Cloud API webhook
//   POST /hooks/ringcentral          RingCentral webhooks (HMAC-SHA256)
//   POST /hooks/elevenlabs           ElevenLabs conversation events (HMAC)
//   GET  /t/o/:msg_id.gif            email open tracking pixel (1x1)
//   GET  /t/c/:msg_id                email click redirect
//   GET  /u/:token                   one-click unsubscribe (RFC 8058)
//   POST /u/:token                   one-click unsubscribe POST variant

import { Hono } from 'hono';
import type { BaseEnv, InboundEmailPayload, InboundWaPayload, VoicePostcallPayload } from '@icrv/shared/types';
import { uuidv4, nowISO, hmacSha256Hex, timingSafeEqual, verifyGoogleJwt, fromBase64Url } from '@icrv/shared/crypto';

interface HooksEnv extends BaseEnv {
  WA_APP_SECRET:       string;
  RC_WEBHOOK_TOKEN:    string;
  EL_WEBHOOK_SECRET:   string;
  GMAIL_PUBSUB_AUD:    string;
  HOOKS_DOMAIN:        string;
}

const app = new Hono<{ Bindings: HooksEnv }>();

app.get('/health', (c) => c.json({ ok: true, service: 'icrv-hooks', ts: nowISO() }));

// ─── Persist raw payload to R2 for audit ─────────────────────────────────────
async function archiveRaw(env: HooksEnv, source: string, body: ArrayBuffer, signature?: string): Promise<{ uri: string; webhook_id: string }> {
  const id  = uuidv4();
  const uri = `webhooks/${source}/${new Date().toISOString().slice(0,10)}/${id}`;
  await env.R2_EVIDENCE.put(uri, body, { httpMetadata: { contentType: 'application/octet-stream' } });
  await env.DB.prepare(
    `INSERT INTO webhooks_received (id, source, payload_uri, signature, status, received_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`,
  ).bind(id, source, uri, signature ?? null, nowISO()).run();
  return { uri, webhook_id: id };
}

// ─── 1) Gmail push (Google Pub/Sub) ──────────────────────────────────────────
app.post('/hooks/gmail/push', async (c) => {
  const auth = c.req.header('Authorization') ?? '';
  const tok  = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tok) return c.json({ error: 'missing_oidc_token' }, 401);

  try {
    await verifyGoogleJwt(tok, c.env.GMAIL_PUBSUB_AUD);
  } catch (err) {
    return c.json({ error: 'oidc_verify_failed', detail: (err as Error).message }, 401);
  }

  const raw = await c.req.arrayBuffer();
  const body = JSON.parse(new TextDecoder().decode(raw)) as { message?: { data?: string; messageId?: string } };
  const data = body.message?.data
    ? JSON.parse(new TextDecoder().decode(fromBase64Url(body.message.data.replace(/=+$/,'')))) as { emailAddress?: string; historyId?: string }
    : {};

  const { uri } = await archiveRaw(c.env, 'gmail', raw);

  // Find oauth_token for this email; we only forward minimum metadata downstream
  let oauthTokenId: string | undefined;
  if (data.emailAddress) {
    const r = await c.env.DB.prepare(
      `SELECT id, tenant_id FROM oauth_tokens WHERE provider = 'gmail' AND email = ? AND is_active = 1 LIMIT 1`,
    ).bind(data.emailAddress).first<{ id: string; tenant_id: string }>();
    if (r) oauthTokenId = r.id;
  }

  const payload: InboundEmailPayload = {
    id: uuidv4(), type: 'email_in',
    tenant_id: '', // resolved downstream from oauth_token row
    attempt: 1, enqueued_at: nowISO(),
    raw_payload_uri: uri, history_id: data.historyId, oauth_token_id: oauthTokenId,
  };
  await c.env.Q_EMAIL_IN.send(payload);
  return new Response('ok', { status: 200 });
});

// ─── 2) WhatsApp Cloud API ───────────────────────────────────────────────────
app.get('/hooks/whatsapp', async (c) => {
  const mode      = c.req.query('hub.mode');
  const token     = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  const expected  = await c.env.KV_CONFIG.get('whatsapp_verify_token');
  if (mode === 'subscribe' && token && expected && timingSafeEqual(token, expected)) {
    return new Response(challenge ?? '', { status: 200 });
  }
  return new Response('forbidden', { status: 403 });
});

app.post('/hooks/whatsapp', async (c) => {
  const sigHeader = c.req.header('X-Hub-Signature-256') ?? '';
  if (!sigHeader.startsWith('sha256=')) return c.json({ error: 'missing_signature' }, 401);
  const provided = sigHeader.slice(7);

  const raw = await c.req.arrayBuffer();
  const expected = await hmacSha256Hex(c.env.WA_APP_SECRET, new TextDecoder().decode(raw));
  if (!timingSafeEqual(provided, expected)) return c.json({ error: 'bad_signature' }, 401);

  const { uri } = await archiveRaw(c.env, 'whatsapp', raw, provided);
  const payload: InboundWaPayload = {
    id: uuidv4(), type: 'wa_in', tenant_id: '',
    attempt: 1, enqueued_at: nowISO(),
    raw_payload_uri: uri,
  };
  await c.env.Q_WA_IN.send(payload);
  return new Response('ok', { status: 200 });
});

// ─── 3) RingCentral ──────────────────────────────────────────────────────────
app.post('/hooks/ringcentral', async (c) => {
  // RC sends a one-time validation token on subscription create
  const validation = c.req.header('Validation-Token');
  if (validation) {
    return new Response('', { status: 200, headers: { 'Validation-Token': validation } });
  }
  const sig = c.req.header('Verification-Token') ?? '';
  if (!timingSafeEqual(sig, c.env.RC_WEBHOOK_TOKEN)) {
    return c.json({ error: 'bad_signature' }, 401);
  }

  const raw  = await c.req.arrayBuffer();
  const body = JSON.parse(new TextDecoder().decode(raw)) as {
    body?: {
      telephonySessionId?: string; partyId?: string;
      parties?: Array<{ id: string; status?: { code?: string }; direction?: string }>;
      sessionId?: string; eventType?: string;
    };
    event?: string;
  };

  const { uri } = await archiveRaw(c.env, 'ringcentral', raw, sig);

  // Correlate by telephonySessionId → call_logs.rc_session_id
  const rcSessionId = body.body?.telephonySessionId ?? body.body?.sessionId;
  if (rcSessionId) {
    const call = await c.env.DB.prepare(
      `SELECT id, correlation_id, tenant_id FROM call_logs WHERE rc_session_id = ? LIMIT 1`,
    ).bind(rcSessionId).first<{ id: string; correlation_id: string; tenant_id: string }>();
    if (call) {
      const code = body.body?.parties?.[0]?.status?.code?.toLowerCase();
      const newStatus = code === 'answered' ? 'connected'
                      : code === 'disconnected' ? 'ended'
                      : code === 'voicemail' ? 'voicemail'
                      : code === 'noanswer' ? 'no_answer'
                      : code === 'setup' || code === 'proceeding' || code === 'alerting' ? 'ringing'
                      : null;
      if (newStatus) {
        // Update call_log status (robust version):
        if (newStatus === 'ended') {
          await c.env.DB.prepare(`UPDATE call_logs SET status=?, ended_at=?, updated_at=? WHERE id=?`)
            .bind(newStatus, nowISO(), nowISO(), call.id).run();
        } else if (newStatus === 'connected') {
          await c.env.DB.prepare(`UPDATE call_logs SET status=?, answered_at=?, updated_at=? WHERE id=?`)
            .bind(newStatus, nowISO(), nowISO(), call.id).run();
        } else {
          await c.env.DB.prepare(`UPDATE call_logs SET status=?, updated_at=? WHERE id=?`)
            .bind(newStatus, nowISO(), call.id).run();
        }
      }

      // Update VoiceSessionDO
      const stub = c.env.VOICE_SESSION_DO.get(c.env.VOICE_SESSION_DO.idFromName(call.correlation_id));
      await stub.fetch('http://do/event', {
        method: 'POST',
        body: JSON.stringify({ rc_session_id: rcSessionId, status: newStatus ?? undefined }),
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});

      // On end → enqueue post-call processing
      if (newStatus === 'ended' || newStatus === 'voicemail' || newStatus === 'no_answer') {
        const payload: VoicePostcallPayload = {
          id: uuidv4(), type: 'voice_postcall',
          tenant_id: call.tenant_id, attempt: 1, enqueued_at: nowISO(),
          call_log_id: call.id, contact_id: '', // looked up downstream from call_log
          rc_credential_id: '', el_credential_id: '',
          rc_call_id: rcSessionId, correlation_id: call.correlation_id,
        };
        await c.env.Q_VOICE_POSTCALL.send(payload);
      }
    }
  }

  return new Response('ok', { status: 200 });
});

// ─── 4) ElevenLabs ──────────────────────────────────────────────────────────
app.post('/hooks/elevenlabs', async (c) => {
  const sig = c.req.header('ElevenLabs-Signature') ?? c.req.header('X-Elevenlabs-Signature') ?? '';
  const raw = await c.req.arrayBuffer();
  const expected = await hmacSha256Hex(c.env.EL_WEBHOOK_SECRET, new TextDecoder().decode(raw));
  if (!sig || !timingSafeEqual(sig.replace(/^sha256=/, ''), expected)) {
    return c.json({ error: 'bad_signature' }, 401);
  }

  const body = JSON.parse(new TextDecoder().decode(raw)) as {
    type?: string;
    conversation_id?: string;
    correlation_id?: string;       // we set this in our agent metadata when starting the call
    transcript?: Array<{ role: 'user'|'agent'; message: string; time_in_call_secs?: number }>;
    agent_response?: { agent_response: string };
    user_transcript?: { user_transcript: string };
    audio_url?: string;
  };
  await archiveRaw(c.env, 'elevenlabs', raw, sig);

  const corr = body.correlation_id;
  if (!corr) return new Response('ok', { status: 200 });

  const stub = c.env.VOICE_SESSION_DO.get(c.env.VOICE_SESSION_DO.idFromName(corr));

  // Incremental transcript chunks
  if (body.user_transcript?.user_transcript) {
    await stub.fetch('http://do/transcript', {
      method: 'POST',
      body: JSON.stringify({ speaker: 'contact', text: body.user_transcript.user_transcript, t_ms: Date.now() }),
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (body.agent_response?.agent_response) {
    await stub.fetch('http://do/transcript', {
      method: 'POST',
      body: JSON.stringify({ speaker: 'ai', text: body.agent_response.agent_response, t_ms: Date.now() }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Final post-call event
  if (body.type === 'post_call_transcription' || body.type === 'conversation.ended') {
    if (body.transcript) {
      const call = await c.env.DB.prepare(
        `SELECT id FROM call_logs WHERE correlation_id = ? LIMIT 1`,
      ).bind(corr).first<{ id: string }>();
      if (call) {
        for (const seg of body.transcript) {
          await c.env.DB.prepare(
            `INSERT INTO call_transcripts (id, call_log_id, speaker, text, timestamp_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            uuidv4(), call.id,
            seg.role === 'agent' ? 'ai' : 'contact',
            seg.message, Math.round((seg.time_in_call_secs ?? 0) * 1000), nowISO(),
          ).run();
        }
        await c.env.DB.prepare(
          `UPDATE call_logs SET el_conversation_id = ?, updated_at = ? WHERE id = ?`,
        ).bind(body.conversation_id ?? null, nowISO(), call.id).run();
      }
    }
  }

  return new Response('ok', { status: 200 });
});

// ─── 5) Email open tracking pixel ───────────────────────────────────────────
const TRANSPARENT_GIF = new Uint8Array([
  0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0x00,0x00,0x00,
  0xff,0xff,0xff,0x21,0xf9,0x04,0x01,0x00,0x00,0x00,0x00,0x2c,0x00,0x00,0x00,0x00,
  0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b,
]);
app.get('/t/o/:msgGif', async (c) => {
  const f = c.req.param('msgGif');
  const messageId = f.replace(/\.gif$/, '');
  // Increment open counter in KV (flushed hourly to D1 by icrv-cron)
  const key = `open:${messageId}`;
  const cur = parseInt((await c.env.KV_TRACK.get(key)) ?? '0', 10);
  await c.env.KV_TRACK.put(key, String(cur + 1), { expirationTtl: 7200 });
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma':        'no-cache',
    },
  });
});

// ─── 6) Email click redirect ────────────────────────────────────────────────
app.get('/t/c/:msgId', async (c) => {
  const messageId = c.req.param('msgId');
  const target = c.req.query('u') ?? '/';
  const key = `click:${messageId}`;
  const cur = parseInt((await c.env.KV_TRACK.get(key)) ?? '0', 10);
  await c.env.KV_TRACK.put(key, String(cur + 1), { expirationTtl: 7200 });

  // Validate target URL
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad_proto');
    return Response.redirect(u.toString(), 302);
  } catch {
    return c.json({ error: 'invalid_target' }, 400);
  }
});

// ─── 7) One-click unsubscribe ───────────────────────────────────────────────
async function processUnsubscribe(env: HooksEnv, token: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await env.DB.prepare(
    `SELECT id, tenant_id, contact_id, email, channel FROM unsubscribes WHERE token = ?`,
  ).bind(token).first<{ id: string; tenant_id: string; contact_id?: string; email?: string; channel: string }>();
  if (!r) return { ok: false, reason: 'token_not_found' };
  const now = nowISO();

  if (r.contact_id) {
    await env.DB.prepare(
      `INSERT INTO consents (id, tenant_id, contact_id, channel, consent_state, recorded_at, updated_at)
       VALUES (?, ?, ?, ?, 'revoked', ?, ?)
       ON CONFLICT(tenant_id, contact_id, channel)
       DO UPDATE SET consent_state='revoked', updated_at=excluded.updated_at`,
    ).bind(uuidv4(), r.tenant_id, r.contact_id, r.channel, now, now).run();
  }
  await env.DB.prepare(
    `INSERT INTO suppressions (id, tenant_id, contact_id, email, reason, created_at)
     VALUES (?, ?, ?, ?, 'one_click_unsubscribe', ?)`,
  ).bind(uuidv4(), r.tenant_id, r.contact_id ?? null, r.email ?? null, now).run();
  return { ok: true };
}

app.get('/u/:token', async (c) => {
  const res = await processUnsubscribe(c.env, c.req.param('token'));
  if (!res.ok) return c.text(`Unable to process: ${res.reason}`, 404);
  return c.html('<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>Unsubscribed</h1><p>You will no longer receive these emails.</p></body></html>');
});
app.post('/u/:token', async (c) => {
  const res = await processUnsubscribe(c.env, c.req.param('token'));
  if (!res.ok) return c.json({ error: res.reason }, 404);
  return c.json({ unsubscribed: true });
});

app.notFound((c) => c.json({ error: 'not_found', path: new URL(c.req.url).pathname }, 404));
app.onError((err, c) => {
  console.error('[icrv-hooks]', err);
  return c.json({ error: 'internal_error', detail: (err as Error).message }, 500);
});

export default { fetch: app.fetch } satisfies ExportedHandler<HooksEnv>;
