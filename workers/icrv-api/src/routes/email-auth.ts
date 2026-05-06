// workers/icrv-api/src/routes/email-auth.ts
// Phase 3 — DKIM / SPF / DMARC DNS lookup + verification.
// Public endpoints under /v1/auth/check-{dkim,spf,dmarc} are Access-gated.
// Lookup uses Cloudflare DNS-over-HTTPS at https://cloudflare-dns.com/dns-query.

import { Hono } from 'hono';
import type { HonoCtx } from '../env';

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

  return app;
}
