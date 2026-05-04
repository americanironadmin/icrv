// workers/icrv-api/src/routes/misc.ts
// /v1/dashboard/*, /v1/logs, /v1/auth/me, /v1/auth/google/*, /v1/admin/*

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import { encryptSecret, uuidv4, nowISO } from '@icrv/shared/crypto';
import { requireAdmin } from '../auth';

export function createDashboardRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/stats', async (c) => {
    const tenantId = c.get('tenant_id');
    const [contacts, activeCamps, emails, was, calls, ai] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ?`).bind(tenantId).first<{ n: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM campaigns WHERE tenant_id = ? AND status = 'active'`).bind(tenantId).first<{ n: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND channel='email' AND direction='outbound' AND status IN ('sent','delivered')`).bind(tenantId).first<{ n: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND channel='whatsapp' AND direction='outbound' AND status IN ('sent','delivered')`).bind(tenantId).first<{ n: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM call_logs WHERE tenant_id = ? AND direction='outbound'`).bind(tenantId).first<{ n: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE tenant_id = ?`).bind(tenantId).first<{ n: number }>(),
    ]);
    return c.json({
      total_contacts: contacts?.n ?? 0,
      active_campaigns: activeCamps?.n ?? 0,
      emails_sent: emails?.n ?? 0,
      whatsapp_sent: was?.n ?? 0,
      calls_made: calls?.n ?? 0,
      ai_actions_triggered: ai?.n ?? 0,
      updated_at: new Date().toISOString(),
    });
  });

  app.get('/activity', async (c) => {
    const tenantId = c.get('tenant_id');
    const limit = Math.min(100, parseInt(c.req.query('limit') ?? '20', 10));

    const r = await c.env.DB.prepare(
      `SELECT 'message' AS kind, m.id, m.channel, m.direction, m.status,
              m.contact_id, ct.name AS contact_name,
              m.created_at AS occurred_at, m.subject AS detail
       FROM messages m JOIN contacts ct ON ct.id = m.contact_id
       WHERE m.tenant_id = ?
       UNION ALL
       SELECT 'call' AS kind, cl.id, 'voice' AS channel, cl.direction, cl.status,
              cl.contact_id, ct.name AS contact_name, cl.created_at AS occurred_at,
              COALESCE(cl.outcome, cl.status) AS detail
       FROM call_logs cl JOIN contacts ct ON ct.id = cl.contact_id
       WHERE cl.tenant_id = ?
       UNION ALL
       SELECT 'agent' AS kind, ar.id, 'ai' AS channel, 'outbound' AS direction, ar.status,
              ar.contact_id, ct.name AS contact_name, ar.created_at AS occurred_at,
              ar.trigger_type AS detail
       FROM agent_runs ar JOIN contacts ct ON ct.id = ar.contact_id
       WHERE ar.tenant_id = ?
       ORDER BY occurred_at DESC LIMIT ?`,
    ).bind(tenantId, tenantId, tenantId, limit).all<{
      kind: 'message'|'call'|'agent'; id: string; channel: string; direction: string;
      status: string; contact_id: string; contact_name: string; occurred_at: string; detail?: string|null;
    }>();

    const items = (r.results ?? []).map(row => {
      let type: string;
      if (row.kind === 'message') type = row.direction === 'outbound' ? `${row.channel}_sent` : `${row.channel}_received`;
      else if (row.kind === 'call') type = row.direction === 'outbound' ? 'call_made' : 'call_received';
      else type = 'ai_action';
      return {
        id: row.id, type, contact_id: row.contact_id, contact_name: row.contact_name,
        detail: row.detail ?? '', status: row.status, occurred_at: row.occurred_at,
      };
    });

    return c.json({ items, total: items.length });
  });

  app.get('/status', async (c) => {
    const tenantId = c.get('tenant_id');
    const r = await c.env.DB.prepare(
      `SELECT provider, MAX(updated_at) AS last_seen, MAX(is_active) AS active
       FROM api_credentials WHERE tenant_id = ? GROUP BY provider`,
    ).bind(tenantId).all<{ provider: string; last_seen: string; active: number }>();
    const have = new Map<string, { last: string; active: boolean }>();
    for (const row of r.results ?? []) have.set(row.provider, { last: row.last_seen, active: row.active === 1 });
    const services: Array<{ service: 'gmail'|'whatsapp'|'ringcentral'|'elevenlabs'; connected: boolean; last_checked: string; error?: string }> = [];
    for (const svc of ['gmail','whatsapp','ringcentral','elevenlabs'] as const) {
      const v = have.get(svc);
      services.push({
        service: svc, connected: !!v?.active,
        last_checked: v?.last ?? new Date().toISOString(),
        error: v ? undefined : 'no_credential_configured',
      });
    }
    return c.json({ services });
  });

  return app;
}

// ── /v1/logs ─────────────────────────────────────────────────────────────────

export function createLogsRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/', async (c) => {
    const tenantId = c.get('tenant_id');
    const q = c.req.query();
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const perPage = Math.min(200, Math.max(1, parseInt(q.per_page ?? '50', 10)));
    const where: string[] = ['m.tenant_id = ?']; const binds: unknown[] = [tenantId];
    if (q.contact_id)  { where.push('m.contact_id = ?');  binds.push(q.contact_id); }
    if (q.campaign_id) { where.push('m.campaign_id = ?'); binds.push(q.campaign_id); }
    if (q.date_from)   { where.push('m.created_at >= ?'); binds.push(q.date_from); }
    if (q.date_to)     { where.push('m.created_at <= ?'); binds.push(q.date_to); }
    const order = q.sort === 'asc' ? 'ASC' : 'DESC';

    // Build a generic feed by unioning messages + call_logs + agent_runs, projected
    // to the LogEntry shape the frontend expects.
    const sql = `
      SELECT id, tenant_id, event_type, contact_id, contact_name, contact_email,
             campaign_id, campaign_name, message_id, call_log_id, agent_run_id,
             status, payload_json, occurred_at
      FROM (
        SELECT m.id AS id, m.tenant_id AS tenant_id,
               (CASE WHEN m.channel='email' AND m.direction='outbound' THEN 'email_sent'
                     WHEN m.channel='email' AND m.direction='inbound'  THEN 'email_received'
                     WHEN m.channel='whatsapp' AND m.direction='outbound' THEN 'whatsapp_sent'
                     WHEN m.channel='whatsapp' AND m.direction='inbound'  THEN 'whatsapp_replied'
                     ELSE m.channel END) AS event_type,
               m.contact_id AS contact_id, ct.name AS contact_name, ct.email AS contact_email,
               m.campaign_id AS campaign_id, cm.name AS campaign_name,
               m.id AS message_id, NULL AS call_log_id, m.agent_run_id AS agent_run_id,
               m.status AS status, m.subject AS payload_json, m.created_at AS occurred_at
        FROM messages m
        JOIN contacts ct ON ct.id = m.contact_id
        LEFT JOIN campaigns cm ON cm.id = m.campaign_id
        WHERE ${where.join(' AND ')}
        UNION ALL
        SELECT cl.id AS id, cl.tenant_id AS tenant_id,
               (CASE WHEN cl.status='connected' THEN 'call_connected'
                     WHEN cl.status='ended'     THEN 'call_ended'
                     WHEN cl.status='voicemail' THEN 'call_voicemail'
                     ELSE 'call_initiated' END) AS event_type,
               cl.contact_id AS contact_id, ct.name AS contact_name, ct.email AS contact_email,
               cl.campaign_id AS campaign_id, cm.name AS campaign_name,
               NULL AS message_id, cl.id AS call_log_id, cl.agent_run_id AS agent_run_id,
               cl.status AS status, cl.outcome AS payload_json, cl.created_at AS occurred_at
        FROM call_logs cl
        JOIN contacts ct ON ct.id = cl.contact_id
        LEFT JOIN campaigns cm ON cm.id = cl.campaign_id
        WHERE ${where.join(' AND ').replace(/m\./g, 'cl.')}
        UNION ALL
        SELECT ar.id AS id, ar.tenant_id AS tenant_id, 'ai_action' AS event_type,
               ar.contact_id AS contact_id, ct.name AS contact_name, ct.email AS contact_email,
               ar.campaign_id AS campaign_id, cm.name AS campaign_name,
               NULL AS message_id, NULL AS call_log_id, ar.id AS agent_run_id,
               ar.status AS status, ar.trigger_type AS payload_json, ar.created_at AS occurred_at
        FROM agent_runs ar
        JOIN contacts ct ON ct.id = ar.contact_id
        LEFT JOIN campaigns cm ON cm.id = ar.campaign_id
        WHERE ${where.join(' AND ').replace(/m\./g, 'ar.')}
      ) feed
      ${q.event_type ? 'WHERE event_type = ?' : ''}
      ORDER BY occurred_at ${order}
      LIMIT ? OFFSET ?
    `;

    // Bindings: where binds appear three times (messages, call_logs, agent_runs)
    const triBinds = [...binds, ...binds, ...binds];
    if (q.event_type) triBinds.push(q.event_type);
    triBinds.push(perPage, (page - 1) * perPage);

    const r = await c.env.DB.prepare(sql).bind(...triBinds).all<{
      id: string; tenant_id: string; event_type: string;
      contact_id?: string|null; contact_name?: string|null; contact_email?: string|null;
      campaign_id?: string|null; campaign_name?: string|null;
      message_id?: string|null; call_log_id?: string|null; agent_run_id?: string|null;
      status: string; payload_json?: string|null; occurred_at: string;
    }>();

    return c.json({
      logs: (r.results ?? []).map(row => ({
        id: row.id, tenant_id: row.tenant_id, event_type: row.event_type,
        contact_id:    row.contact_id ?? undefined, contact_name: row.contact_name ?? undefined,
        contact_email: row.contact_email ?? undefined,
        campaign_id:   row.campaign_id ?? undefined, campaign_name: row.campaign_name ?? undefined,
        message_id:    row.message_id ?? undefined, call_log_id:   row.call_log_id ?? undefined,
        agent_run_id:  row.agent_run_id ?? undefined,
        status: row.status,
        payload: row.payload_json ? { detail: row.payload_json } : undefined,
        occurred_at: row.occurred_at,
      })),
      total: 0, page, per_page: perPage,  // total left as 0 for performance; FE uses items length
    });
  });

  app.get('/:id', async (c) => {
    // simplified — find in any of the three feed tables
    const id = c.req.param('id'); const tenantId = c.get('tenant_id');
    const m = await c.env.DB.prepare(`SELECT * FROM messages WHERE id=? AND tenant_id=?`).bind(id, tenantId).first<Record<string, unknown>>();
    if (m) return c.json({ id, ...m });
    const cl = await c.env.DB.prepare(`SELECT * FROM call_logs WHERE id=? AND tenant_id=?`).bind(id, tenantId).first<Record<string, unknown>>();
    if (cl) return c.json({ id, ...cl });
    const ar = await c.env.DB.prepare(`SELECT * FROM agent_runs WHERE id=? AND tenant_id=?`).bind(id, tenantId).first<Record<string, unknown>>();
    if (ar) return c.json({ id, ...ar });
    return c.json({ error: 'not_found' }, 404);
  });

  return app;
}

// ── /v1/auth ─────────────────────────────────────────────────────────────────

export function createAuthRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/me', async (c) => {
    const tenantId = c.get('tenant_id'); const userId = c.get('user_id');
    const row = await c.env.DB.prepare(
      `SELECT id, email, name, role, tenant_id FROM users WHERE id = ? AND tenant_id = ?`,
    ).bind(userId, tenantId).first<{ id: string; email: string; name?: string|null; role: 'admin'|'operator'|'viewer'; tenant_id: string }>();
    if (!row) return c.json({ error: 'user_not_found' }, 404);
    return c.json({
      user: {
        id: row.id, email: row.email, name: row.name ?? row.email, role: row.role, tenant_id: row.tenant_id,
      },
    });
  });

  // ── Google OAuth — initiation (requires authenticated admin user) ──────────
  app.get('/google/start', async (c) => {
    if (c.get('user_role') !== 'admin') return c.json({ error: 'admin_required' }, 403);
    const tenantId = c.get('tenant_id');
    const userId   = c.get('user_id');

    // Generate one-time CSRF state bound to user session (30 min TTL)
    const stateId = crypto.randomUUID();
    await c.env.KV_OAUTH.put(
      `oauth_state:${stateId}`,
      JSON.stringify({ tenant_id: tenantId, user_id: userId }),
      { expirationTtl: 1800 },
    );

    const params = new URLSearchParams({
      client_id:     c.env.GOOGLE_CLIENT_ID,
      redirect_uri:  'https://icrv-api.americanironadmin.workers.dev/oauth/google/callback',
      response_type: 'code',
      scope:         [
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ].join(' '),
      access_type:   'offline',
      prompt:        'consent',
      state:         stateId,
    });

    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  // ── Google OAuth — connection status ──────────────────────────────────────
  app.get('/google/status', async (c) => {
    const tenantId = c.get('tenant_id');
    const row = await c.env.DB.prepare(
      `SELECT id, email, created_at FROM oauth_tokens WHERE tenant_id=? AND provider='gmail' AND is_active=1 ORDER BY created_at DESC LIMIT 1`,
    ).bind(tenantId).first<{ id: string; email: string|null; created_at: string }>();
    if (!row) return c.json({ connected: false });
    return c.json({ connected: true, email: row.email, oauth_token_id: row.id, connected_at: row.created_at });
  });

  // ── Logout — revoke this JWT's JTI in KV_REVOKED + return Access logout URL
  // The frontend POSTs here, then navigates to `logout_url` so Cloudflare Access
  // wipes its own session cookie too.
  app.post('/logout', async (c) => {
    const jti = c.get('jwt_jti');
    const exp = c.get('jwt_exp');
    if (jti && c.env.KV_REVOKED) {
      const ttl = exp ? Math.max(60, exp - Math.floor(Date.now() / 1000)) : 86400;
      await c.env.KV_REVOKED.put(`revoked:${jti}`, '1', { expirationTtl: ttl });
    }
    const logoutUrl = c.env.CF_ACCESS_TEAM_DOMAIN
      ? `https://${c.env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout`
      : null;
    return c.json(
      { ok: true, logout_url: logoutUrl },
      200,
      { 'Clear-Site-Data': '"cookies"' },
    );
  });

  return app;
}

// ── /v1/admin — one-time bootstrap of wrangler secrets into D1 ───────────────

export function createAdminRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  // Enforce admin-only for all /admin routes
  app.use('*', requireAdmin);

  /**
   * POST /v1/admin/bootstrap-credentials
   *
   * Reads EL_API_KEY and RC_JWT from the worker's own environment (wrangler
   * secrets), encrypts them with MASTER_KEK, and stores them in D1
   * api_credentials so the rest of the system can load them per-tenant.
   *
   * Also creates an ElevenLabs Conversational AI agent pointed at our custom
   * LLM proxy and stores the agent_id in KV_CONFIG.
   *
   * Finally attempts to register a RingCentral webhook subscription if full
   * RC credentials are present.
   *
   * Idempotent — skips already-provisioned credentials.
   */
  app.post('/bootstrap-credentials', async (c) => {
    const tenantId = c.get('tenant_id');
    const now = nowISO();
    const results: Record<string, unknown> = { tenant_id: tenantId };

    // ── Delegate secret-reading to icrv-voice (which holds EL_API_KEY + RC_JWT) ─
    // icrv-api does NOT have EL_API_KEY or RC_JWT; they live in icrv-voice.
    // We call icrv-voice's /bootstrap endpoint via service binding and merge its
    // results into our response.
    try {
      const voiceRes = await c.env.VOICE.fetch(new Request('http://icrv-voice.internal/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId }),
      }));
      const voiceData = await voiceRes.json() as Record<string, unknown>;
      Object.assign(results, voiceData);
    } catch (err) {
      results.voice_bootstrap_error = (err as Error).message;
    }

    // ── Gmail OAuth status ──────────────────────────────────────────────────────
    const gmailRow = await c.env.DB.prepare(
      `SELECT id, email FROM oauth_tokens WHERE tenant_id=? AND provider='gmail' AND is_active=1 LIMIT 1`,
    ).bind(tenantId).first<{ id: string; email: string | null }>();
    results.gmail_connected = !!gmailRow;
    if (gmailRow) {
      results.gmail_email = gmailRow.email;
      results.gmail_oauth_token_id = gmailRow.id;
      results.gmail = 'connected';
    } else {
      results.gmail = 'not_connected — use GET /v1/auth/google/start to authorise';
    }

    // ── ElevenLabs credential ──────────────────────────────────────────────────
    // (handled by icrv-voice above; duplicated below only for direct-read fallback)
    const elApiKey = c.env.EL_API_KEY;
    if (false && elApiKey) { // icrv-api doesn't have EL_API_KEY; skipped
      const existing = await c.env.DB.prepare(
        `SELECT id FROM api_credentials WHERE tenant_id=? AND provider='elevenlabs' AND is_active=1 LIMIT 1`,
      ).bind(tenantId).first<{ id: string }>();

      if (!existing) {
        const elId = uuidv4();
        const enc = await encryptSecret(JSON.stringify({ api_key: elApiKey }), c.env.MASTER_KEK, tenantId, 1);
        await c.env.DB.prepare(
          `INSERT INTO api_credentials (id,tenant_id,provider,label,cipher_text,iv,auth_tag,key_version,metadata_json,is_active,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
        ).bind(elId, tenantId, 'elevenlabs', 'ElevenLabs API Key', enc.cipher_text, enc.iv, enc.auth_tag, enc.key_version, null, now, now).run();
        results.elevenlabs_credential_id = elId;
        results.elevenlabs = 'provisioned';
      } else {
        results.elevenlabs = 'already_exists';
        results.elevenlabs_credential_id = existing!.id;
      }

      // ── ElevenLabs Conversational AI agent ──────────────────────────────────
      const existingAgentId = await c.env.KV_CONFIG.get(`el_agent_id:${tenantId}`);
      if (!existingAgentId) {
        const llmSecret = c.env.EL_LLM_SHARED_SECRET;
        const extraHeaders = llmSecret
          ? [{ name: 'X-Shared-Secret', value: llmSecret }]
          : [];

        const agentBody = {
          name: 'ICRV Sales Agent',
          conversation_config: {
            agent: {
              prompt: {
                prompt: [
                  'You are a professional AI sales assistant for American Iron, a company specializing in steel',
                  'and metal products. Be helpful, concise, and professional.',
                  'Collect contact information naturally. Qualify the prospect and schedule follow-ups.',
                  'Keep responses short — this is a phone call, not an email.',
                ].join(' '),
              },
              first_message: "Hello! This is an AI sales assistant from American Iron. How can I help you today?",
              language: 'en',
            },
            tts: {
              model_id: 'eleven_turbo_v2_5',
              voice_id: '21m00Tcm4TlvDq8ikWAM', // Rachel — clear, professional
            },
            llm: {
              model: 'custom',
              custom_llm: {
                server: {
                  url: 'https://icrv-voice.americanironadmin.workers.dev/llm/v1',
                  extra_headers: extraHeaders,
                },
              },
              temperature: 0.5,
              max_tokens: 500,
            },
            turn: {
              mode: 'turn_detector',
              turn_timeout: 7,
            },
          },
        };

        const agentRes = await fetch('https://api.elevenlabs.io/v1/convai/agents', {
          method: 'POST',
          headers: { 'xi-api-key': elApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(agentBody),
        });

        if (agentRes.ok) {
          const agentData = await agentRes.json() as { agent_id: string };
          await c.env.KV_CONFIG.put(`el_agent_id:${tenantId}`, agentData.agent_id);
          results.el_agent = 'created';
          results.el_agent_id = agentData.agent_id;
        } else {
          const errText = await agentRes.text();
          results.el_agent = `error_${agentRes.status}`;
          results.el_agent_error = errText.slice(0, 300);
        }
      } else {
        results.el_agent = 'already_exists';
        results.el_agent_id = existingAgentId;
      }
    } else {
      results.elevenlabs = 'EL_API_KEY_not_set';
    }

    // ── RingCentral credential ─────────────────────────────────────────────────
    const rcJwtRaw = c.env.RC_JWT;
    if (rcJwtRaw) {
      const existing = await c.env.DB.prepare(
        `SELECT id FROM api_credentials WHERE tenant_id=? AND provider='ringcentral' AND is_active=1 LIMIT 1`,
      ).bind(tenantId).first<{ id: string }>();

      // Normalise: RC_JWT may be a full JSON object or just the JWT string.
      // loadRcCredentials expects: { jwt, client_id, client_secret, server }
      let rcCred: { jwt: string; client_id: string; client_secret: string; server: string };
      try {
        const parsed = JSON.parse(rcJwtRaw) as Record<string, string>;
        rcCred = {
          jwt:           parsed.jwt ?? rcJwtRaw,
          client_id:     parsed.client_id ?? '',
          client_secret: parsed.client_secret ?? '',
          server:        parsed.server ?? 'https://platform.ringcentral.com',
        };
      } catch {
        // Plain JWT string — client_id/secret still needed from RC developer console
        rcCred = { jwt: rcJwtRaw, client_id: '', client_secret: '', server: 'https://platform.ringcentral.com' };
      }

      if (!existing) {
        const rcId = uuidv4();
        const enc = await encryptSecret(JSON.stringify(rcCred), c.env.MASTER_KEK, tenantId, 1);
        const rcMeta = JSON.stringify({ from_phone_e164: '', el_trunk_phone_e164: '' });
        await c.env.DB.prepare(
          `INSERT INTO api_credentials (id,tenant_id,provider,label,cipher_text,iv,auth_tag,key_version,metadata_json,is_active,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
        ).bind(rcId, tenantId, 'ringcentral', 'RingCentral', enc.cipher_text, enc.iv, enc.auth_tag, enc.key_version, rcMeta, now, now).run();
        results.ringcentral_credential_id = rcId;
        results.ringcentral = 'provisioned';
      } else {
        results.ringcentral = 'already_exists';
        results.ringcentral_credential_id = existing.id;
      }

      // ── RC webhook subscription ───────────────────────────────────────────────
      const existingSubId = await c.env.KV_CONFIG.get(`rc_subscription_id:${tenantId}`);
      if (!existingSubId && rcCred.client_id && rcCred.client_secret && rcCred.jwt) {
        try {
          const tokRes = await fetch(`${rcCred.server}/restapi/oauth/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${btoa(`${rcCred.client_id}:${rcCred.client_secret}`)}`,
            },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              assertion:  rcCred.jwt,
            }),
          });

          if (tokRes.ok) {
            const tokData = await tokRes.json() as { access_token: string };

            const subRes = await fetch(`${rcCred.server}/restapi/v1.0/subscription`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${tokData.access_token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                eventFilters: [
                  '/restapi/v1.0/account/~/telephony/sessions',
                  '/restapi/v1.0/account/~/extension/~/telephony/sessions',
                ],
                deliveryMode: {
                  transportType:     'WebHook',
                  address:           'https://icrv-hooks.americanironadmin.workers.dev/hooks/ringcentral',
                  verificationToken: c.env.RC_WEBHOOK_TOKEN ?? '',
                },
                expiresIn: 630720000, // max allowed by RC (~20 years)
              }),
            });

            if (subRes.ok) {
              const subData = await subRes.json() as { id: string; status: string };
              await c.env.KV_CONFIG.put(`rc_subscription_id:${tenantId}`, subData.id);
              results.rc_webhook = 'registered';
              results.rc_subscription_id = subData.id;
            } else {
              const errText = await subRes.text();
              results.rc_webhook = `error_${subRes.status}`;
              results.rc_webhook_error = errText.slice(0, 300);
            }
          } else {
            const errText = await tokRes.text();
            results.rc_token = `error_${tokRes.status}`;
            results.rc_token_error = errText.slice(0, 300);
          }
        } catch (err) {
          results.rc_webhook = 'exception';
          results.rc_webhook_error = (err as Error).message;
        }
      } else if (existingSubId) {
        results.rc_webhook = 'already_registered';
        results.rc_subscription_id = existingSubId;
      } else {
        results.rc_webhook = 'skipped_incomplete_credentials';
      }
    } else {
      results.ringcentral = 'RC_JWT_not_set';
    }

    return c.json({ ok: true, ...results });
  });

  // ── GET /v1/admin/integrations ─────────────────────────────────────────────
  // Returns the current configuration state for the Settings UI: which
  // integrations are connected, what label/email is shown, and what metadata
  // (phone_number_id, business_id, etc.) is stored.
  app.get('/integrations', async (c) => {
    const tenantId = c.get('tenant_id');

    const gmail = await c.env.DB.prepare(
      `SELECT id, email FROM oauth_tokens WHERE tenant_id=? AND provider='gmail' AND is_active=1 LIMIT 1`,
    ).bind(tenantId).first<{ id: string; email: string|null }>();

    const wa = await c.env.DB.prepare(
      `SELECT id, label, metadata_json FROM api_credentials WHERE tenant_id=? AND provider='whatsapp' AND is_active=1 LIMIT 1`,
    ).bind(tenantId).first<{ id: string; label: string; metadata_json: string|null }>();

    const rc = await c.env.DB.prepare(
      `SELECT id, label, metadata_json FROM api_credentials WHERE tenant_id=? AND provider='ringcentral' AND is_active=1 LIMIT 1`,
    ).bind(tenantId).first<{ id: string; label: string; metadata_json: string|null }>();

    const el = await c.env.DB.prepare(
      `SELECT id, label, metadata_json FROM api_credentials WHERE tenant_id=? AND provider='elevenlabs' AND is_active=1 LIMIT 1`,
    ).bind(tenantId).first<{ id: string; label: string; metadata_json: string|null }>();

    const elAgentId = await c.env.KV_CONFIG.get(`el_agent_id:${tenantId}`);

    return c.json({
      gmail: { connected: !!gmail, email: gmail?.email ?? null, oauth_token_id: gmail?.id ?? null },
      whatsapp: {
        connected: !!wa,
        credential_id: wa?.id ?? null,
        label: wa?.label ?? null,
        metadata: wa?.metadata_json ? JSON.parse(wa.metadata_json) : {},
      },
      ringcentral: {
        connected: !!rc,
        credential_id: rc?.id ?? null,
        label: rc?.label ?? null,
        metadata: rc?.metadata_json ? JSON.parse(rc.metadata_json) : {},
      },
      elevenlabs: {
        connected: !!el,
        credential_id: el?.id ?? null,
        label: el?.label ?? null,
        agent_id: elAgentId,
        metadata: el?.metadata_json ? JSON.parse(el.metadata_json) : {},
      },
    });
  });

  // ── POST /v1/admin/integrations/whatsapp ──────────────────────────────────
  // Body: { phone_number_id, business_id, access_token }
  // Encrypts access_token + business_id with MASTER_KEK, stores encrypted blob
  // in api_credentials.cipher_text, and stores phone_number_id + business_id in
  // metadata_json so loadWaCredentials can read them without decrypting.
  app.post('/integrations/whatsapp', async (c) => {
    const tenantId = c.get('tenant_id');
    let body: { phone_number_id?: string; business_id?: string; access_token?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const phoneNumberId = (body.phone_number_id ?? '').trim();
    const businessId    = (body.business_id ?? '').trim();
    const accessToken   = (body.access_token ?? '').trim();
    if (!phoneNumberId || !accessToken) {
      return c.json({ error: 'missing_required', detail: 'phone_number_id and access_token are required' }, 400);
    }

    const enc = await encryptSecret(
      JSON.stringify({ access_token: accessToken, business_id: businessId }),
      c.env.MASTER_KEK, tenantId, 1,
    );
    const meta = JSON.stringify({ phone_number_id: phoneNumberId, business_id: businessId });
    const now = nowISO();

    // Deactivate any prior WA credential for this tenant
    await c.env.DB.prepare(
      `UPDATE api_credentials SET is_active=0, updated_at=? WHERE tenant_id=? AND provider='whatsapp'`,
    ).bind(now, tenantId).run();

    const id = uuidv4();
    await c.env.DB.prepare(
      `INSERT INTO api_credentials
         (id,tenant_id,provider,label,cipher_text,iv,auth_tag,key_version,metadata_json,is_active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
    ).bind(
      id, tenantId, 'whatsapp', `WhatsApp Business (${phoneNumberId})`,
      enc.cipher_text, enc.iv, enc.auth_tag, enc.key_version, meta, now, now,
    ).run();

    return c.json({ ok: true, credential_id: id, phone_number_id: phoneNumberId });
  });

  // ── PUT /v1/admin/integrations/elevenlabs ─────────────────────────────────
  // Body: { agent_id?, phone_number_id? }
  //   agent_id        — sets KV_CONFIG el_agent_id:<tenant> (which agent to use)
  //   phone_number_id — sets metadata_json.phone_number_id on the EL credential
  //                     (placeCall reads this and sends as agent_phone_number_id
  //                     to the EL outbound-call API).
  // Both fields are optional — caller can update one or both.
  app.put('/integrations/elevenlabs', async (c) => {
    const tenantId = c.get('tenant_id');
    let body: { agent_id?: string; phone_number_id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const agentId       = (body.agent_id ?? '').trim();
    const phoneNumberId = (body.phone_number_id ?? '').trim();
    if (!agentId && !phoneNumberId) {
      return c.json({ error: 'missing_required', detail: 'agent_id or phone_number_id required' }, 400);
    }

    const result: Record<string, unknown> = { ok: true };

    if (agentId) {
      await c.env.KV_CONFIG.put(`el_agent_id:${tenantId}`, agentId);
      result.agent_id = agentId;
    }

    if (phoneNumberId) {
      const cred = await c.env.DB.prepare(
        `SELECT id, metadata_json FROM api_credentials WHERE tenant_id=? AND provider='elevenlabs' AND is_active=1 LIMIT 1`,
      ).bind(tenantId).first<{ id: string; metadata_json: string|null }>();
      if (!cred) {
        return c.json({ error: 'elevenlabs_credential_missing', detail: 'Run /v1/admin/bootstrap-credentials first to provision the EL credential' }, 409);
      }
      const meta = cred.metadata_json ? JSON.parse(cred.metadata_json) as Record<string, string> : {};
      meta['phone_number_id'] = phoneNumberId;
      await c.env.DB.prepare(
        `UPDATE api_credentials SET metadata_json=?, updated_at=? WHERE id=?`,
      ).bind(JSON.stringify(meta), nowISO(), cred.id).run();
      result.phone_number_id = phoneNumberId;
      result.credential_id = cred.id;
    }

    return c.json(result);
  });

  // ── POST /v1/admin/bootstrap-templates ─────────────────────────────────────
  // Idempotently seeds one default template per channel for the caller's tenant
  // so the campaign builder's Template <select> is never empty for new tenants.
  // Skips any channel that already has at least one template.
  app.post('/bootstrap-templates', async (c) => {
    const tenantId = c.get('tenant_id');
    const now = nowISO();

    const defaults: Array<{
      channel: 'email' | 'whatsapp' | 'voice';
      name: string;
      subject?: string;
      body_html?: string;
      body_text?: string;
      template_name?: string;
    }> = [
      {
        channel: 'email',
        name: 'Default — Intro Email',
        subject: 'Hello from {{tenant_name}}',
        body_html: '<p>Hi {{contact_name}},</p><p>Thanks for connecting with us. Reply to this email any time and we will get back to you.</p><p>— {{from_name}}</p>',
        body_text: 'Hi {{contact_name}},\n\nThanks for connecting with us. Reply to this email any time and we will get back to you.\n\n— {{from_name}}',
      },
      {
        channel: 'whatsapp',
        name: 'Default — WhatsApp Template',
        template_name: 'hello_world',
      },
      {
        channel: 'voice',
        name: 'Default — Voice Script',
        body_text: 'Hi {{contact_name}}, this is {{from_name}} calling from {{tenant_name}}. I wanted to follow up briefly — do you have a minute?',
      },
    ];

    const created: string[] = [];
    const skipped: string[] = [];

    for (const t of defaults) {
      const existing = await c.env.DB.prepare(
        `SELECT id FROM templates WHERE tenant_id=? AND channel=? LIMIT 1`,
      ).bind(tenantId, t.channel).first<{ id: string }>();
      if (existing) { skipped.push(t.channel); continue; }

      await c.env.DB.prepare(
        `INSERT INTO templates
           (id, tenant_id, name, channel, subject, body_html, body_text,
            content_html, content_text, template_name, template_language, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uuidv4(), tenantId, t.name, t.channel,
        t.subject ?? null, t.body_html ?? null, t.body_text ?? null,
        t.body_html ?? null, t.body_text ?? null,
        t.template_name ?? null, t.template_name ? 'en_US' : null, now,
      ).run();
      created.push(t.channel);
    }

    return c.json({ tenant_id: tenantId, created, skipped });
  });

  return app;
}
