// workers/icrv-api/src/routes/public.ts
// Phase 2/3 public endpoints — NO auth, NO Access. These must be added to the
// Cloudflare Access app's Bypass list (manual step, documented in V2 report).
//
//   GET /u/:token        unsubscribe (CAN-SPAM)
//   GET /track/open      transparent 1×1 PNG, logs open
//   GET /r               redirect, logs click

import type { Context } from 'hono';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import type { ApiEnv } from '../env';
import { loadSection } from './settings';

// 1×1 transparent PNG (43 bytes)
const PIXEL_PNG = Uint8Array.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
  0x89,0x00,0x00,0x00,0x0d,0x49,0x44,0x41,0x54,0x78,0x9c,0x62,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
  0x42,0x60,0x82,
]);

// ─── HMAC helpers ───────────────────────────────────────────────────────────

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signToken(secret: string, payload: Record<string, unknown>): Promise<string> {
  const key = await importHmacKey(secret);
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken(
  secret: string, token: string,
): Promise<Record<string, unknown> | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const key = await importHmacKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC', key, fromB64url(sig), new TextEncoder().encode(body),
  );
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(body))) as Record<string, unknown>;
  } catch { return null; }
}

// ─── /u/:token  — Unsubscribe (PUBLIC) ─────────────────────────────────────

export async function handleUnsubscribe(c: Context<{ Bindings: ApiEnv }>): Promise<Response> {
  const token = c.req.param('token');
  if (!token) return c.html(unsubscribePage('Missing token', false), 400);

  // Try HMAC token first (new v2 format).
  let tenant_id: string | undefined;
  let contact_id: string | undefined;
  let campaign_id: string | undefined;

  const secret = c.env.JWT_SIGNING_KEY;
  if (secret) {
    const claims = await verifyToken(secret, token);
    if (claims && typeof claims === 'object') {
      tenant_id   = claims.tenant_id   as string | undefined;
      contact_id  = claims.contact_id  as string | undefined;
      campaign_id = claims.campaign_id as string | undefined;
    }
  }

  // Fallback: legacy UUID token lookup in unsubscribes table.
  if (!tenant_id || !contact_id) {
    const row = await c.env.DB.prepare(
      `SELECT tenant_id, contact_id FROM unsubscribes WHERE token = ? AND channel = 'email' LIMIT 1`,
    ).bind(token).first<{ tenant_id: string; contact_id: string }>();
    if (row) {
      tenant_id = row.tenant_id;
      contact_id = row.contact_id;
    }
  }

  if (!tenant_id || !contact_id) {
    return c.html(unsubscribePage('Invalid or expired link', false), 400);
  }

  const now = nowISO();
  await c.env.DB.prepare(
    `INSERT INTO consents (id, tenant_id, contact_id, channel, consent_state, recorded_at, updated_at)
     VALUES (?, ?, ?, 'email', 'revoked', ?, ?)
     ON CONFLICT(tenant_id, contact_id, channel)
     DO UPDATE SET consent_state='revoked', updated_at=excluded.updated_at`,
  ).bind(uuidv4(), tenant_id, contact_id, now, now).run();

  // Audit row in unsubscribes table. Schema: id, tenant_id, contact_id, email,
  // token, channel, created_at. We don't have email here (we'd need to fetch
  // it); store NULL and let the admin UI join contacts on contact_id.
  try {
    await c.env.DB.prepare(
      `INSERT INTO unsubscribes (id, tenant_id, contact_id, email, token, channel, created_at)
       VALUES (?, ?, ?, (SELECT email FROM contacts WHERE id=? AND tenant_id=?), ?, 'email', ?)`,
    ).bind(uuidv4(), tenant_id, contact_id, contact_id, tenant_id, token.slice(0, 64), now).run();
  } catch (err) {
    console.warn('[unsubscribe] audit insert failed', (err as Error).message);
  }

  return c.html(unsubscribePage('You have been unsubscribed.', true));
}

function unsubscribePage(message: string, ok: boolean): string {
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Unsubscribe — ICRV</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f7f8fa; color: #0a0c0f; margin: 0; padding: 2rem; }
    .card { max-width: 480px; margin: 4rem auto; background: #fff; border-radius: 8px; padding: 2.5rem; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; color: ${color}; }
    p  { color: #4b5563; line-height: 1.6; }
  </style>
</head><body>
  <div class="card">
    <h1>${ok ? 'Unsubscribed' : 'Unsubscribe failed'}</h1>
    <p>${message}</p>
    <p style="margin-top:1.5rem;font-size:0.85rem;color:#9ca3af;">If this was a mistake, contact your ICRV operator.</p>
  </div>
</body></html>`;
}

// ─── /track/open?eid=...  — open pixel (PUBLIC) ──────────────────────────

export async function handleTrackOpen(c: Context<{ Bindings: ApiEnv }>): Promise<Response> {
  const eid = c.req.query('eid');
  const ua  = c.req.header('User-Agent') ?? '';
  const ip  = c.req.header('CF-Connecting-IP') ?? '';
  if (eid) {
    const claims = await verifyToken(c.env.JWT_SIGNING_KEY, eid);
    if (claims) {
      const tenant_id   = claims.tenant_id   as string | undefined;
      const contact_id  = claims.contact_id  as string | undefined;
      const campaign_id = claims.campaign_id as string | undefined;
      if (tenant_id) {
        try {
          await c.env.DB.prepare(
            `INSERT INTO tracking_events (id, tenant_id, contact_id, campaign_id, type, ip, user_agent, occurred_at)
             VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
          ).bind(uuidv4(), tenant_id, contact_id ?? null, campaign_id ?? null, ip.slice(0,64), ua.slice(0,512), nowISO()).run();
        } catch (err) {
          console.warn('[track_open] insert failed', (err as Error).message);
        }
      }
    }
  }
  return new Response(PIXEL_PNG, {
    status: 200,
    headers: {
      'Content-Type':  'image/png',
      'Content-Length': String(PIXEL_PNG.byteLength),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma':        'no-cache',
      'Expires':       '0',
    },
  });
}

// ─── /r?u=<b64url>&eid=...  — click redirect (PUBLIC) ─────────────────────

export async function handleTrackClick(c: Context<{ Bindings: ApiEnv }>): Promise<Response> {
  const u   = c.req.query('u');
  const eid = c.req.query('eid');
  if (!u) return new Response('missing_u', { status: 400 });
  let target: string;
  try {
    target = new TextDecoder().decode(fromB64url(u));
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return new Response('bad_scheme', { status: 400 });
    }
  } catch {
    return new Response('bad_url', { status: 400 });
  }
  if (eid) {
    const claims = await verifyToken(c.env.JWT_SIGNING_KEY, eid);
    if (claims) {
      const tenant_id   = claims.tenant_id   as string | undefined;
      const contact_id  = claims.contact_id  as string | undefined;
      const campaign_id = claims.campaign_id as string | undefined;
      if (tenant_id) {
        try {
          await c.env.DB.prepare(
            `INSERT INTO tracking_events (id, tenant_id, contact_id, campaign_id, type, url, ip, user_agent, occurred_at)
             VALUES (?, ?, ?, ?, 'click', ?, ?, ?, ?)`,
          ).bind(
            uuidv4(), tenant_id, contact_id ?? null, campaign_id ?? null,
            target.slice(0, 1024),
            (c.req.header('CF-Connecting-IP') ?? '').slice(0,64),
            (c.req.header('User-Agent') ?? '').slice(0,512),
            nowISO(),
          ).run();
        } catch (err) {
          console.warn('[track_click] insert failed', (err as Error).message);
        }
      }
    }
  }
  return Response.redirect(target, 302);
}
