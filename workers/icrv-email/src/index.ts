// workers/icrv-email/src/index.ts
// Email send pipeline. Acts as a queue consumer for `icrv-email-out` and an
// HTTP service callable from icrv-consumer. Builds an RFC2822 message,
// rewrites trackable links, and POSTs to the Gmail users.messages.send endpoint
// with a Bearer access_token from OAuthRotatorDO.

import type {
  BaseEnv, EmailOutPayload, InboundEmailPayload, RetryPayload,
} from '@icrv/shared/types';
import { uuidv4, nowISO, toBase64Url } from '@icrv/shared/crypto';
import { rateAllow, isDuplicate, scheduleRetry } from '@icrv/shared/queue-helpers';

interface EmailEnv extends BaseEnv {
  GOOGLE_CLIENT_ID:     string;
  GOOGLE_CLIENT_SECRET: string;
  EMAIL_TRACK_KEY?:     string;
}

// ─── HTTP — health + send-now (called by icrv-consumer service binding) ─────

export default {
  async fetch(req: Request, env: EmailEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'icrv-email' });
    if (url.pathname === '/send' && req.method === 'POST') {
      const payload = await req.json() as EmailOutPayload;
      try {
        const r = await sendEmail(payload, env);
        return Response.json(r);
      } catch (err) {
        return Response.json({ error: 'send_failed', detail: (err as Error).message }, { status: 502 });
      }
    }
    return new Response('not_found', { status: 404 });
  },

  async queue(batch: MessageBatch<EmailOutPayload | RetryPayload>, env: EmailEnv): Promise<void> {
    for (const msg of batch.messages) {
      const body = msg.body;
      const payload: EmailOutPayload = body.type === 'retry'
        ? body.original_payload as EmailOutPayload
        : body as EmailOutPayload;
      try {
        if (await isDuplicate(env, payload.id)) { msg.ack(); continue; }
        // Tenant-level email rate limit (per-channel sliding window — 10 / sec ≈ 36000/h cap; we set 5000/h)
        const allow = await rateAllow(env, payload.tenant_id, 'email', 5000);
        if (!allow.allowed) { msg.retry({ delaySeconds: 60 }); continue; }

        await sendEmail(payload, env);
        msg.ack();
      } catch (err) {
        await scheduleRetry(env, 'icrv-email-out', payload, (err as Error).message);
        msg.ack();
      }
    }
  },
} satisfies ExportedHandler<EmailEnv, EmailOutPayload | RetryPayload>;

// ─── Core send routine ─────────────────────────────────────────────────────

async function sendEmail(p: EmailOutPayload, env: EmailEnv): Promise<{ ok: true; provider_msg_id: string }> {
  // Mark sending
  await env.DB.prepare(
    `UPDATE messages SET status='sending', updated_at=? WHERE id=?`,
  ).bind(nowISO(), p.message_id).run();

  // Pre-flight: check action wasn't revoked
  const action = await env.DB.prepare(
    `SELECT a.status FROM agent_actions a
     WHERE a.id IN (SELECT id FROM agent_actions WHERE result_ref = ? LIMIT 1)`,
  ).bind(p.message_id).first<{ status: string }>();
  if (action?.status === 'revoked') {
    await env.DB.prepare(`UPDATE messages SET status='failed', error='action_revoked', updated_at=? WHERE id=?`)
      .bind(nowISO(), p.message_id).run();
    throw new Error('action_revoked');
  }

  // ── Phase 2: CAN-SPAM physical address gate + daily limit ────────────
  const settings = await loadTenantSettings(env, p.tenant_id);
  const street   = (settings.compliance.physical_address?.street ?? '').trim();
  if (!street || street === '__PLACEHOLDER__') {
    await env.DB.prepare(`UPDATE messages SET status='failed', error='compliance_address_missing', updated_at=? WHERE id=?`)
      .bind(nowISO(), p.message_id).run();
    throw new Error('compliance_address_missing');
  }

  // Daily-limit gate (UTC day window).
  const dailyLimit = Number(settings.sending.daily_limit ?? 500);
  const sentToday = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages
       WHERE tenant_id = ? AND channel = 'email' AND direction = 'outbound'
         AND sent_at >= datetime('now','start of day')`,
  ).bind(p.tenant_id).first<{ n: number }>())?.n ?? 0;
  if (sentToday >= dailyLimit) {
    throw new Error(`daily_limit_reached:${dailyLimit}`);
  }

  // Get access token from OAuthRotatorDO
  const stub = env.OAUTH_DO.get(env.OAUTH_DO.idFromName(p.oauth_token_id));
  const tokRes = await stub.fetch('http://do/token', {
    method: 'GET',
    headers: { 'x-oauth-token-id': p.oauth_token_id },
  });
  if (!tokRes.ok) throw new Error(`token_unavailable:${tokRes.status}`);
  const { access_token } = await tokRes.json() as { access_token: string };

  // Rewrite tracking links + add open pixel + List-Unsubscribe
  const trackingHost = p.tracking_domain || 'icrv-api.americanironus.com';
  const unsubUrl = await buildUnsubUrl(env, p, trackingHost);
  const personalized = await personalize(env, p, p.html_body);
  const htmlBody = appendCanSpamFooter(
    await injectTracking(personalized, p, trackingHost, env, settings),
    settings, unsubUrl,
  );
  const headersExtra: string[] = [
    `List-Unsubscribe: <${unsubUrl}>, <mailto:unsubscribe@${trackingHost}?subject=unsubscribe>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  ];

  const raw = buildRfc2822({
    to_email: p.to_email, to_name: p.to_name,
    from_email: p.from_email, from_name: p.from_name,
    subject: p.subject, html: htmlBody, text: p.text_body ?? stripHtml(htmlBody),
    reply_to: p.reply_to, extra_headers: headersExtra,
  });

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: toBase64Url(new TextEncoder().encode(raw)) }),
  });

  if (!sendRes.ok) {
    const text = await sendRes.text();
    await env.DB.prepare(`UPDATE messages SET status='failed', error=?, updated_at=? WHERE id=?`)
      .bind(text.slice(0, 500), nowISO(), p.message_id).run();
    throw new Error(`gmail_${sendRes.status}:${text.slice(0,200)}`);
  }

  const data = await sendRes.json() as { id: string; threadId?: string };

  await env.DB.prepare(
    `UPDATE messages SET status='sent', provider_msg_id=?, sent_at=?, updated_at=? WHERE id=?`,
  ).bind(data.id, nowISO(), nowISO(), p.message_id).run();

  // Mark agent_action sent
  await env.DB.prepare(
    `UPDATE agent_actions SET status='sent', updated_at=? WHERE result_ref = ?`,
  ).bind(nowISO(), p.message_id).run();

  return { ok: true, provider_msg_id: data.id };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function buildUnsubUrl(env: EmailEnv, p: EmailOutPayload, host: string): Promise<string> {
  if (env.EMAIL_TRACK_KEY) {
    const token = await signHmacToken(env.EMAIL_TRACK_KEY, {
      tenant_id:   p.tenant_id,
      contact_id:  p.contact_id,
      campaign_id: p.campaign_id ?? null,
      message_id:  p.message_id,
      iat:         Math.floor(Date.now() / 1000),
    });
    return `https://${host}/u/${token}`;
  }
  // Fallback: legacy UUID token, persisted in unsubscribes table.
  const existing = await env.DB.prepare(
    `SELECT token FROM unsubscribes WHERE tenant_id=? AND (contact_id=? OR email=?) AND channel='email' LIMIT 1`,
  ).bind(p.tenant_id, p.contact_id, p.to_email).first<{ token: string }>();
  if (existing) return `https://${host}/u/${existing.token}`;
  const token = uuidv4();
  await env.DB.prepare(
    `INSERT INTO unsubscribes (id, tenant_id, contact_id, email, token, channel, created_at)
     VALUES (?, ?, ?, ?, ?, 'email', ?)`,
  ).bind(uuidv4(), p.tenant_id, p.contact_id, p.to_email, token, nowISO()).run();
  return `https://${host}/u/${token}`;
}

interface TrackingSettings {
  open_tracking?: boolean;
  click_tracking?: boolean;
  custom_domain?: string;
  utm_prefix?: string;
  utm_medium?: string;
  utm_campaign_prefix?: string;
}

async function injectTracking(
  html: string, p: EmailOutPayload, trackingDomain: string,
  env: EmailEnv, settings: TenantSettingsView,
): Promise<string> {
  const tr = (settings as unknown as { tracking?: TrackingSettings }).tracking ?? {};
  const openOn  = tr.open_tracking !== false;
  const clickOn = tr.click_tracking !== false;
  const utmSource   = tr.utm_prefix || 'icrv';
  const utmMedium   = tr.utm_medium || 'email';
  const utmCampaign = `${tr.utm_campaign_prefix || ''}${p.campaign_id ?? p.message_id}`;

  const eid = env.EMAIL_TRACK_KEY ? await signHmacToken(env.EMAIL_TRACK_KEY, {
    tenant_id:   p.tenant_id,
    contact_id:  p.contact_id,
    campaign_id: p.campaign_id ?? null,
    message_id:  p.message_id,
    iat:         Math.floor(Date.now() / 1000),
  }) : '';

  // Rewrite <a href="…"> to redirect via tracking endpoint with UTM params.
  let rewritten = html;
  if (clickOn) {
    rewritten = html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*)>/gi, (_m, before, href, after) => {
      if (/^(mailto:|tel:|#)/i.test(href)) return `<a ${before}href="${href}"${after}>`;
      const withUtm = appendUtm(href, utmSource, utmMedium, utmCampaign);
      const b64 = b64urlEncode(new TextEncoder().encode(withUtm));
      const target = `https://${trackingDomain}/r?u=${encodeURIComponent(b64)}${eid ? `&eid=${eid}` : ''}`;
      return `<a ${before}href="${target}"${after}>`;
    });
  }
  // Insert open pixel before </body> (or append if no </body>).
  if (openOn && eid) {
    const pixel = `<img src="https://${trackingDomain}/track/open?eid=${eid}" width="1" height="1" alt="" style="display:none" />`;
    if (/<\/body>/i.test(rewritten)) return rewritten.replace(/<\/body>/i, `${pixel}</body>`);
    return rewritten + pixel;
  }
  return rewritten;
}

function appendUtm(href: string, source: string, medium: string, campaign: string): string {
  try {
    const u = new URL(href);
    if (!u.searchParams.has('utm_source'))   u.searchParams.set('utm_source', source);
    if (!u.searchParams.has('utm_medium'))   u.searchParams.set('utm_medium', medium);
    if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch {
    return href;
  }
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signHmacToken(secret: string, payload: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

function buildRfc2822(opts: {
  to_email: string; to_name?: string;
  from_email: string; from_name?: string;
  subject: string; html: string; text: string;
  reply_to?: string; extra_headers?: string[];
}): string {
  const boundary = `=_icrv_${uuidv4().replace(/-/g, '')}`;
  const fromHdr  = opts.from_name ? `${encodeMimeWord(opts.from_name)} <${opts.from_email}>` : opts.from_email;
  const toHdr    = opts.to_name   ? `${encodeMimeWord(opts.to_name)} <${opts.to_email}>`     : opts.to_email;

  const headers = [
    `From: ${fromHdr}`,
    `To: ${toHdr}`,
    `Subject: ${encodeMimeWord(opts.subject)}`,
    `MIME-Version: 1.0`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${uuidv4()}@${opts.from_email.split('@')[1] ?? 'icrv.app'}>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (opts.reply_to) headers.push(`Reply-To: ${opts.reply_to}`);
  for (const h of (opts.extra_headers ?? [])) headers.push(h);

  const body =
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset="utf-8"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    `${opts.text}\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset="utf-8"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    `${opts.html}\r\n\r\n` +
    `--${boundary}--`;

  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

function encodeMimeWord(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  // RFC 2047 Q encoding
  const enc = [...new TextEncoder().encode(s)]
    .map(b => (b === 0x20 ? '_' : (b >= 0x21 && b <= 0x7E && b !== 0x3D && b !== 0x3F && b !== 0x5F)
      ? String.fromCharCode(b) : '=' + b.toString(16).toUpperCase().padStart(2, '0')))
    .join('');
  return `=?utf-8?Q?${enc}?=`;
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<[^>]+>/g, ' ')
             .replace(/&nbsp;/g, ' ')
             .replace(/\s+/g, ' ').trim();
}

// ─── Tenant settings (Phase 2) ─────────────────────────────────────────────

interface TenantSettingsView {
  workspace:  Record<string, unknown> & { company_name?: string };
  compliance: Record<string, unknown> & {
    physical_address?: { street?: string; city?: string; state?: string; zip?: string; country?: string };
    unsubscribe_text?: string;
  };
  sending:    Record<string, unknown> & { daily_limit?: number; throttle_per_sec?: number };
  tracking:   Record<string, unknown> & { open_tracking?: boolean; click_tracking?: boolean; custom_domain?: string; utm_prefix?: string; utm_medium?: string; utm_campaign_prefix?: string };
}

async function loadTenantSettings(env: EmailEnv, tenantId: string): Promise<TenantSettingsView> {
  const row = await env.DB.prepare(
    `SELECT workspace_json, compliance_json, sending_json, tracking_json
       FROM tenant_settings WHERE tenant_id = ?`,
  ).bind(tenantId).first<{ workspace_json: string; compliance_json: string; sending_json: string; tracking_json: string }>();
  const safe = (s?: string): Record<string, unknown> => {
    if (!s) return {};
    try { return JSON.parse(s); } catch { return {}; }
  };
  return {
    workspace:  safe(row?.workspace_json),
    compliance: safe(row?.compliance_json),
    sending:    safe(row?.sending_json),
    tracking:   safe(row?.tracking_json),
  };
}

// ─── Personalization (Phase 5) ─────────────────────────────────────────────
// {{var_name}} resolution order:
//   1. contacts.custom_fields_json[var_name]
//   2. tenant_settings.personalization_json.variables[].default_value
//   3. Empty string

interface PersonalizationVar {
  name: string;
  default_value?: string;
}

async function personalize(env: EmailEnv, p: EmailOutPayload, html: string): Promise<string> {
  if (!html.includes('{{')) return html;
  const contact = await env.DB.prepare(
    `SELECT name, email, phone_e164, country_code, industry, custom_fields_json
       FROM contacts WHERE id = ? AND tenant_id = ?`,
  ).bind(p.contact_id, p.tenant_id).first<{
    name: string; email: string | null; phone_e164: string | null;
    country_code: string | null; industry: string | null;
    custom_fields_json: string | null;
  }>();
  const personRow = await env.DB.prepare(
    `SELECT personalization_json FROM tenant_settings WHERE tenant_id = ?`,
  ).bind(p.tenant_id).first<{ personalization_json: string }>();
  const personalization: { variables?: PersonalizationVar[] } = personRow?.personalization_json
    ? safeParseObj(personRow.personalization_json) as { variables?: PersonalizationVar[] }
    : {};
  const customFields: Record<string, string> = contact?.custom_fields_json
    ? safeParseObj(contact.custom_fields_json) as Record<string, string>
    : {};

  const builtin: Record<string, string> = {
    'contact.name':     contact?.name ?? '',
    'contact.email':    contact?.email ?? '',
    'contact.phone':    contact?.phone_e164 ?? '',
    'contact.country':  contact?.country_code ?? '',
    'contact.industry': contact?.industry ?? '',
    'campaign.name':    p.campaign_id ?? '',
    'workspace.company': '', // resolved at footer level
  };

  return html.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === 'unsubscribe_url') return ''; // resolved separately by footer
    if (Object.prototype.hasOwnProperty.call(builtin, key)) return builtin[key];
    if (Object.prototype.hasOwnProperty.call(customFields, key)) return customFields[key];
    const def = (personalization.variables ?? []).find((v) => v.name === key);
    return def?.default_value ?? '';
  });
}

function safeParseObj(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function appendCanSpamFooter(html: string, settings: TenantSettingsView, unsubUrl: string): string {
  const company = (settings.workspace.company_name as string | undefined) ?? '';
  const a = settings.compliance.physical_address ?? {};
  const addrLine = [a.street, a.city, a.state, a.zip, a.country].filter(Boolean).join(', ');
  const tpl = (settings.compliance.unsubscribe_text as string | undefined)
              ?? 'To stop receiving these emails, unsubscribe here: {{unsubscribe_url}}';
  const unsubText = tpl.replace(/\{\{unsubscribe_url\}\}/g, unsubUrl);

  const footer = `
<hr style="margin:24px 0;border:0;border-top:1px solid #ddd" />
<div style="font-size:12px;color:#6b7280;font-family:Arial,sans-serif;line-height:1.5">
  <div>${escapeHtml(company)}${company && addrLine ? ' · ' : ''}${escapeHtml(addrLine)}</div>
  <div style="margin-top:6px">${escapeHtml(unsubText.replace(unsubUrl, ''))}<a href="${unsubUrl}" style="color:#2563eb">Unsubscribe</a></div>
</div>`;

  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${footer}</body>`);
  return html + footer;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
