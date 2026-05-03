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

  // Get access token from OAuthRotatorDO
  const stub = env.OAUTH_DO.get(env.OAUTH_DO.idFromName(p.oauth_token_id));
  const tokRes = await stub.fetch('http://do/token', {
    method: 'GET',
    headers: { 'x-oauth-token-id': p.oauth_token_id },
  });
  if (!tokRes.ok) throw new Error(`token_unavailable:${tokRes.status}`);
  const { access_token } = await tokRes.json() as { access_token: string };

  // Rewrite tracking links + add open pixel + List-Unsubscribe
  const unsubToken = await ensureUnsubToken(env, p);
  const htmlBody   = injectTracking(p.html_body, p.message_id, p.tracking_domain);
  const headersExtra: string[] = [
    `List-Unsubscribe: <https://${p.tracking_domain}/u/${unsubToken}>, <mailto:unsubscribe@${p.tracking_domain}?subject=unsubscribe>`,
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

async function ensureUnsubToken(env: EmailEnv, p: EmailOutPayload): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT token FROM unsubscribes WHERE tenant_id=? AND (contact_id=? OR email=?) AND channel='email' LIMIT 1`,
  ).bind(p.tenant_id, p.contact_id, p.to_email).first<{ token: string }>();
  if (existing) return existing.token;
  const token = uuidv4();
  await env.DB.prepare(
    `INSERT INTO unsubscribes (id, tenant_id, contact_id, email, token, channel, created_at)
     VALUES (?, ?, ?, ?, ?, 'email', ?)`,
  ).bind(uuidv4(), p.tenant_id, p.contact_id, p.to_email, token, nowISO()).run();
  return token;
}

function injectTracking(html: string, messageId: string, trackingDomain: string): string {
  // Rewrite <a href="…"> to redirect via tracking endpoint
  const rewritten = html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*)>/gi, (_m, before, href, after) => {
    if (/^(mailto:|tel:|#)/i.test(href)) return `<a ${before}href="${href}"${after}>`;
    const target = `https://${trackingDomain}/t/c/${messageId}?u=${encodeURIComponent(href)}`;
    return `<a ${before}href="${target}"${after}>`;
  });
  // Insert open pixel before </body> (or append if no </body>)
  const pixel = `<img src="https://${trackingDomain}/t/o/${messageId}.gif" width="1" height="1" alt="" style="display:none" />`;
  if (/<\/body>/i.test(rewritten)) return rewritten.replace(/<\/body>/i, `${pixel}</body>`);
  return rewritten + pixel;
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
