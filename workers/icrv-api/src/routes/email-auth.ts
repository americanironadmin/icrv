// workers/icrv-api/src/routes/email-auth.ts
// Phase 3 — DKIM / SPF / DMARC DNS lookup + verification.
// Public endpoints under /v1/auth/check-{dkim,spf,dmarc} are Access-gated.
// Lookup uses Cloudflare DNS-over-HTTPS at https://cloudflare-dns.com/dns-query.

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import { encryptSecret, nowISO } from '@icrv/shared/crypto';

interface DohAnswer { name: string; type: number; TTL: number; data: string }
interface DohResponse { Status: number; Answer?: DohAnswer[] }

const TYPE_TXT = 16;

async function lookupTxt(name: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`;
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
  if (!res.ok) return [];
  const json = await res.json() as DohResponse;
  if (json.Status !== 0 || !json.Answer) return [];
  return json.Answer
    .filter((a) => a.type === TYPE_TXT)
    .map((a) => a.data.replace(/^"|"$/g, '').replace(/"\s+"/g, ''));
}

function parseDomainSelector(c: import('hono').Context): { domain: string; selector: string } {
  const domain = (c.req.query('domain') ?? '').trim().toLowerCase();
  const selector = (c.req.query('selector') ?? 'icrv').trim();
  return { domain, selector };
}

const SPF_EXPECTED = 'v=spf1 include:_spf.google.com include:icrv-email.americanironadmin.workers.dev ~all';

export function createEmailAuthRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/check-dkim', async (c) => {
    const { domain, selector } = parseDomainSelector(c);
    if (!domain) return c.json({ error: 'domain_required' }, 400);
    const records = await lookupTxt(`${selector}._domainkey.${domain}`);
    const found = records.find((r) => /v=DKIM1/i.test(r));
    return c.json({
      verified: !!found,
      found: found ?? null,
      expected: `${selector}._domainkey.${domain} TXT v=DKIM1; k=rsa; p=… (configured at your DNS provider)`,
    });
  });

  app.get('/check-spf', async (c) => {
    const domain = (c.req.query('domain') ?? '').trim().toLowerCase();
    if (!domain) return c.json({ error: 'domain_required' }, 400);
    const records = await lookupTxt(domain);
    const spf = records.find((r) => /^v=spf1/i.test(r));
    const verified = !!spf && /icrv-email\.americanironadmin\.workers\.dev|_spf\.google\.com/i.test(spf);
    return c.json({ verified, found: spf ?? null, expected: SPF_EXPECTED });
  });

  app.get('/check-dmarc', async (c) => {
    const domain = (c.req.query('domain') ?? '').trim().toLowerCase();
    if (!domain) return c.json({ error: 'domain_required' }, 400);
    const records = await lookupTxt(`_dmarc.${domain}`);
    const dmarc = records.find((r) => /v=DMARC1/i.test(r));
    return c.json({
      verified: !!dmarc,
      found: dmarc ?? null,
      expected: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; ruf=mailto:dmarc@${domain}; fo=1`,
    });
  });

  // ── POST /v1/auth/generate-dkim ─────────────────────────────────────
  // Generates an RSA-2048 keypair, stores private key encrypted with
  // MASTER_KEK in KV_CONFIG, returns the public key as the SPKI base64
  // string (the `p=…` portion of the DKIM TXT record).
  app.post('/generate-dkim', async (c) => {
    if (c.get('user_role') !== 'admin') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const body = await c.req.json<{ selector?: string; rotate?: boolean }>()
      .catch(() => ({} as { selector?: string; rotate?: boolean }));
    const selector = (body.selector ?? 'icrv').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'icrv';

    const kvKey = `dkim:${tenantId}:${selector}`;
    if (!body.rotate) {
      const existing = await c.env.KV_CONFIG.get(kvKey, 'json') as { public_key_b64?: string } | null;
      if (existing?.public_key_b64) {
        return c.json({ selector, public_key_b64: existing.public_key_b64, rotated: false });
      }
    }

    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([0x01, 0x00, 0x01]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;

    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    const publicB64  = btoa(String.fromCharCode(...new Uint8Array(spki)));
    const privateB64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));

    const enc = await encryptSecret(privateB64, c.env.MASTER_KEK, tenantId, 1);
    const stored = {
      selector,
      public_key_b64:   publicB64,
      private_cipher:   enc.cipher_text,
      private_iv:       enc.iv,
      private_auth_tag: enc.auth_tag,
      key_version:      enc.key_version,
      created_at:       nowISO(),
    };
    await c.env.KV_CONFIG.put(kvKey, JSON.stringify(stored));

    // Mirror selector + public key into tenant_settings.authentication_json
    // so the verifier UI shows the right `p=…` without re-fetching from KV.
    const cur = await c.env.DB.prepare(
      `SELECT authentication_json FROM tenant_settings WHERE tenant_id=?`,
    ).bind(tenantId).first<{ authentication_json: string }>();
    const auth: Record<string, unknown> = cur?.authentication_json
      ? safeParse(cur.authentication_json) : {};
    auth.dkim_selector = selector;
    auth.dkim_public_key = publicB64;
    auth.dkim_generated_at = nowISO();
    await c.env.DB.prepare(
      `INSERT INTO tenant_settings (tenant_id, authentication_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         authentication_json=excluded.authentication_json,
         updated_at=excluded.updated_at`,
    ).bind(tenantId, JSON.stringify(auth), nowISO()).run();

    return c.json({
      selector,
      public_key_b64: publicB64,
      rotated: !!body.rotate,
      dns_record: `${selector}._domainkey TXT "v=DKIM1; k=rsa; p=${publicB64}"`,
    });
  });

  return app;
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
