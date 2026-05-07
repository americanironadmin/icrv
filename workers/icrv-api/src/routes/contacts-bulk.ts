// workers/icrv-api/src/routes/contacts-bulk.ts
// v2.6 — bulk operations on contacts:
//
//   POST /v1/contacts/bulk             — delete | add_tag | remove_tag | set_tags |
//                                        set_field | set_consent
//   POST /v1/contacts/consent-request  — send consent-request emails to selected
//                                        contacts (or only-pending resend)
//   GET  /v1/contacts/consent-summary  — counts by consent state for the UI
//
// Selection model (every endpoint accepts the same `filter` shape):
//   { all: true }                       — every contact in the tenant
//   { ids: ["uuid1","uuid2",...] }      — explicit list (chunked to 250 / SQL)
//   { search, tag, country, industry,   — server-side WHERE; no row-count cap
//     consent_state, has_email }
//
// "No limit": for set_field / delete we use a single WHERE-clause UPDATE/DELETE
// (D1 handles 100k rows per statement easily). For tag mutations (read-merge-write)
// we resolve the filter to IDs in pages of 1000 and process each row inline.

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import type { EmailOutPayload } from '@icrv/shared/types';

const ID_BATCH = 250;     // max IDs per IN-clause SQL chunk
const ROW_BATCH = 1000;   // tag-mutation page size

const ALLOWED_FIELDS = new Set([
  'country_code', 'country_name_ar', 'industry', 'industry_ar', 'region_tier',
]);

interface BulkFilter {
  all?:           boolean;
  ids?:           string[];
  search?:        string;
  tag?:           string;
  country?:       string;
  industry?:      string;
  has_email?:     boolean;
  consent_state?: 'granted' | 'revoked' | 'pending' | 'none' | 'never_requested';
  consent_channel?: 'email' | 'whatsapp' | 'voice';
}

interface BulkBody {
  filter: BulkFilter;
  action: 'delete' | 'add_tag' | 'remove_tag' | 'set_tags' | 'set_field' | 'set_consent';
  params?: {
    tag?:     string;
    tags?:    string[];
    field?:   string;
    value?:   string | null;
    channel?: 'email' | 'whatsapp' | 'voice';
    state?:   'granted' | 'revoked';
  };
}

export function createContactsBulkRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/consent-summary', async (c) => {
    const tenantId = c.get('tenant_id');
    const channel = c.req.query('channel') ?? 'email';
    const total = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM contacts WHERE tenant_id=?`,
    ).bind(tenantId).first<{ n: number }>())?.n ?? 0;

    const states = await c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN consent_state='granted' THEN 1 ELSE 0 END) AS granted,
         SUM(CASE WHEN consent_state='revoked' THEN 1 ELSE 0 END) AS revoked,
         SUM(CASE WHEN consent_state='none' AND requested_at IS NOT NULL THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN consent_state='none' AND requested_at IS NULL THEN 1 ELSE 0 END) AS none
       FROM consents WHERE tenant_id=? AND channel=?`,
    ).bind(tenantId, channel).first<{ granted: number; revoked: number; pending: number; none: number }>();
    const granted = states?.granted ?? 0;
    const revoked = states?.revoked ?? 0;
    const pending = states?.pending ?? 0;
    const noneRow = states?.none ?? 0;
    const never_requested = total - granted - revoked - pending - noneRow + noneRow; // contacts with NO consents row at all
    const tracked = granted + revoked + pending + noneRow;
    return c.json({
      channel,
      total,
      granted,
      revoked,
      pending,
      never_requested: Math.max(0, total - tracked),
    });
  });

  app.post('/bulk', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const body = await c.req.json<BulkBody>().catch(() => null);
    if (!body || !body.filter || !body.action) return c.json({ error: 'invalid_body' }, 400);

    switch (body.action) {
      case 'delete':       return c.json(await bulkDelete(c.env.DB, tenantId, body.filter));
      case 'add_tag':      return c.json(await bulkTags(c.env.DB, tenantId, body.filter, 'add', body.params?.tag));
      case 'remove_tag':   return c.json(await bulkTags(c.env.DB, tenantId, body.filter, 'remove', body.params?.tag));
      case 'set_tags':     return c.json(await bulkTags(c.env.DB, tenantId, body.filter, 'set', body.params?.tags ?? []));
      case 'set_field':    return c.json(await bulkSetField(c.env.DB, tenantId, body.filter, body.params?.field ?? '', body.params?.value ?? null));
      case 'set_consent':  return c.json(await bulkSetConsent(c.env.DB, tenantId, body.filter, body.params?.channel ?? 'email', body.params?.state ?? 'granted'));
      default: return c.json({ error: 'unknown_action' }, 400);
    }
  });

  app.post('/consent-request', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const body = await c.req.json<{ filter: BulkFilter; only_pending?: boolean }>().catch(() => null);
    if (!body || !body.filter) return c.json({ error: 'invalid_body' }, 400);

    const sender = await pickActiveGmailSender(c.env.DB, tenantId);
    if (!sender) return c.json({ error: 'no_active_gmail_sender' }, 422);

    let filter: BulkFilter = body.filter;
    if (body.only_pending) {
      filter = { ...filter, consent_state: 'pending', consent_channel: 'email' };
    }
    // Always require an email address — we can't send to NULL.
    filter = { ...filter, has_email: true };

    const queued = await sendConsentRequests(c.env, tenantId, filter, sender);
    return c.json(queued);
  });

  return app;
}

// ─── Filter resolution ─────────────────────────────────────────────────────

interface ResolvedFilter {
  whereSql: string;
  binds:    unknown[];
}

function resolveFilter(tenantId: string, filter: BulkFilter): ResolvedFilter {
  const where: string[] = ['c.tenant_id = ?'];
  const binds: unknown[] = [tenantId];

  if (filter.search) {
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone_e164 LIKE ?)');
    const q = `%${filter.search}%`;
    binds.push(q, q, q);
  }
  if (filter.tag) {
    where.push(`c.id IN (SELECT contact_id FROM contact_tags WHERE tenant_id=? AND tag=?)`);
    binds.push(tenantId, filter.tag);
  }
  if (filter.country)  { where.push('c.country_code = ?');     binds.push(filter.country); }
  if (filter.industry) { where.push('c.industry = ?');         binds.push(filter.industry); }
  if (filter.has_email) { where.push("c.email IS NOT NULL AND c.email <> ''"); }

  if (filter.consent_state) {
    const ch = filter.consent_channel ?? 'email';
    switch (filter.consent_state) {
      case 'granted':
      case 'revoked':
      case 'none':
        where.push(`c.id IN (SELECT contact_id FROM consents WHERE tenant_id=? AND channel=? AND consent_state=?)`);
        binds.push(tenantId, ch, filter.consent_state);
        break;
      case 'pending':
        where.push(`c.id IN (SELECT contact_id FROM consents WHERE tenant_id=? AND channel=? AND consent_state='none' AND requested_at IS NOT NULL)`);
        binds.push(tenantId, ch);
        break;
      case 'never_requested':
        where.push(`c.id NOT IN (SELECT contact_id FROM consents WHERE tenant_id=? AND channel=?)`);
        binds.push(tenantId, ch);
        break;
    }
  }

  return { whereSql: where.join(' AND '), binds };
}

// ─── Bulk DELETE ───────────────────────────────────────────────────────────

async function bulkDelete(db: D1Database, tenantId: string, filter: BulkFilter): Promise<{ affected: number }> {
  if (filter.ids && filter.ids.length > 0) {
    let total = 0;
    for (let i = 0; i < filter.ids.length; i += ID_BATCH) {
      const chunk = filter.ids.slice(i, i + ID_BATCH);
      const placeholders = chunk.map(() => '?').join(',');
      const res = await db.prepare(
        `DELETE FROM contacts WHERE tenant_id = ? AND id IN (${placeholders})`,
      ).bind(tenantId, ...chunk).run();
      total += res.meta?.changes ?? 0;
      // Cascade deletes — schema lacks ON DELETE CASCADE so we clean manually.
      await db.prepare(`DELETE FROM consents      WHERE tenant_id = ? AND contact_id IN (${placeholders})`).bind(tenantId, ...chunk).run();
      await db.prepare(`DELETE FROM contact_tags  WHERE tenant_id = ? AND contact_id IN (${placeholders})`).bind(tenantId, ...chunk).run();
      await db.prepare(`DELETE FROM lead_scores   WHERE tenant_id = ? AND contact_id IN (${placeholders})`).bind(tenantId, ...chunk).run();
    }
    return { affected: total };
  }

  // Filter-based: subquery delete. SQLite supports DELETE … WHERE id IN (SELECT…).
  const f = resolveFilter(tenantId, filter);
  const idSql = `SELECT c.id FROM contacts c WHERE ${f.whereSql}`;
  // First snapshot the matching IDs so we can cascade.
  const matches = await db.prepare(idSql).bind(...f.binds).all<{ id: string }>();
  const ids = (matches.results ?? []).map((r) => r.id);
  if (ids.length === 0) return { affected: 0 };
  return bulkDelete(db, tenantId, { ids });
}

// ─── Bulk TAGS ─────────────────────────────────────────────────────────────

async function bulkTags(
  db: D1Database, tenantId: string, filter: BulkFilter,
  mode: 'add' | 'remove' | 'set', payload: string | string[] | undefined,
): Promise<{ affected: number }> {
  if (mode !== 'set' && (typeof payload !== 'string' || !payload.trim())) {
    return { affected: 0 };
  }
  if (mode === 'set' && !Array.isArray(payload)) {
    return { affected: 0 };
  }
  const ids = await resolveIds(db, tenantId, filter);
  if (ids.length === 0) return { affected: 0 };

  let touched = 0;
  for (let i = 0; i < ids.length; i += ROW_BATCH) {
    const chunk = ids.slice(i, i + ROW_BATCH);
    const ph = chunk.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT id, tags_json FROM contacts WHERE tenant_id = ? AND id IN (${ph})`,
    ).bind(tenantId, ...chunk).all<{ id: string; tags_json: string | null }>();

    for (const r of rows.results ?? []) {
      const cur: string[] = r.tags_json ? safeArr(r.tags_json) : [];
      let next: string[];
      if (mode === 'add') {
        const tag = (payload as string).trim();
        next = cur.includes(tag) ? cur : [...cur, tag];
      } else if (mode === 'remove') {
        const tag = (payload as string).trim();
        next = cur.filter((t) => t !== tag);
      } else {
        next = (payload as string[]).map((t) => t.trim()).filter(Boolean);
      }
      // No-op skip
      if (mode !== 'set' && next.length === cur.length && next.every((v, i) => v === cur[i])) continue;
      await db.prepare(
        `UPDATE contacts SET tags_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      ).bind(JSON.stringify(next), nowISO(), r.id, tenantId).run();
      touched++;
    }
  }
  return { affected: touched };
}

// ─── Bulk SET FIELD ────────────────────────────────────────────────────────

async function bulkSetField(
  db: D1Database, tenantId: string, filter: BulkFilter, field: string, value: string | null,
): Promise<{ affected: number }> {
  if (!ALLOWED_FIELDS.has(field)) {
    throw new Error(`field_not_allowed:${field}`);
  }
  const safeValue = value === '' ? null : value;

  if (filter.ids && filter.ids.length > 0) {
    let total = 0;
    for (let i = 0; i < filter.ids.length; i += ID_BATCH) {
      const chunk = filter.ids.slice(i, i + ID_BATCH);
      const ph = chunk.map(() => '?').join(',');
      const res = await db.prepare(
        `UPDATE contacts SET ${field} = ?, updated_at = ? WHERE tenant_id = ? AND id IN (${ph})`,
      ).bind(safeValue, nowISO(), tenantId, ...chunk).run();
      total += res.meta?.changes ?? 0;
    }
    return { affected: total };
  }

  const f = resolveFilter(tenantId, filter);
  // Use a subquery so we don't have to materialise IDs in the worker for huge
  // filter results.
  const res = await db.prepare(
    `UPDATE contacts SET ${field} = ?, updated_at = ?
       WHERE id IN (SELECT c.id FROM contacts c WHERE ${f.whereSql})`,
  ).bind(safeValue, nowISO(), ...f.binds).run();
  return { affected: res.meta?.changes ?? 0 };
}

// ─── Bulk SET CONSENT ──────────────────────────────────────────────────────

async function bulkSetConsent(
  db: D1Database, tenantId: string, filter: BulkFilter,
  channel: 'email' | 'whatsapp' | 'voice', state: 'granted' | 'revoked',
): Promise<{ affected: number }> {
  const ids = await resolveIds(db, tenantId, filter);
  let touched = 0;
  const now = nowISO();
  for (const cid of ids) {
    await db.prepare(
      `INSERT INTO consents (id, tenant_id, contact_id, channel, consent_state, recorded_at, updated_at, granted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, contact_id, channel)
       DO UPDATE SET consent_state=excluded.consent_state, updated_at=excluded.updated_at,
                     granted_at=CASE WHEN excluded.consent_state='granted' THEN excluded.granted_at ELSE consents.granted_at END`,
    ).bind(uuidv4(), tenantId, cid, channel, state, now, now, state === 'granted' ? now : null).run();
    touched++;
  }
  return { affected: touched };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function resolveIds(db: D1Database, tenantId: string, filter: BulkFilter): Promise<string[]> {
  if (filter.ids && filter.ids.length > 0) return filter.ids;
  const f = resolveFilter(tenantId, filter);
  const rows = await db.prepare(
    `SELECT c.id FROM contacts c WHERE ${f.whereSql}`,
  ).bind(...f.binds).all<{ id: string }>();
  return (rows.results ?? []).map((r) => r.id);
}

function safeArr(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
}

// ─── Consent-request emails ────────────────────────────────────────────────

interface SenderContext {
  oauth_token_id: string;
  from_email:     string;
  from_name:      string;
  tracking_domain: string;
}

async function pickActiveGmailSender(db: D1Database, tenantId: string): Promise<SenderContext | null> {
  const row = await db.prepare(
    `SELECT id, email FROM oauth_tokens
      WHERE tenant_id = ? AND provider = 'gmail' AND is_active = 1
      ORDER BY updated_at DESC LIMIT 1`,
  ).bind(tenantId).first<{ id: string; email: string }>();
  if (!row || !row.email) return null;

  // Workspace name for "From: <name>"
  const ws = await db.prepare(
    `SELECT workspace_json FROM tenant_settings WHERE tenant_id = ?`,
  ).bind(tenantId).first<{ workspace_json: string }>();
  let fromName = 'ICRV';
  if (ws?.workspace_json) {
    try {
      const obj = JSON.parse(ws.workspace_json) as { company_name?: string };
      if (obj.company_name) fromName = obj.company_name;
    } catch { /* leave default */ }
  }
  return {
    oauth_token_id:  row.id,
    from_email:      row.email,
    from_name:       fromName,
    tracking_domain: 'icrv-api.americanironus.com',
  };
}

async function sendConsentRequests(
  env: import('../env').ApiEnv, tenantId: string, filter: BulkFilter, sender: SenderContext,
): Promise<{ requested: number; skipped_no_email: number; total_matched: number }> {
  const f = resolveFilter(tenantId, filter);
  const rows = await env.DB.prepare(
    `SELECT c.id, c.name, c.email FROM contacts c WHERE ${f.whereSql}`,
  ).bind(...f.binds).all<{ id: string; name: string; email: string | null }>();
  const matched = rows.results ?? [];

  let requested = 0;
  let skipped = 0;
  const now = nowISO();
  const apiBase = sender.tracking_domain;

  for (const r of matched) {
    if (!r.email) { skipped++; continue; }

    const requestId = uuidv4();
    const token = await signConsentToken(env, {
      tenant_id:   tenantId,
      contact_id:  r.id,
      channel:     'email',
      request_id:  requestId,
      iat:         Math.floor(Date.now() / 1000),
    });

    // Upsert pending state.
    await env.DB.prepare(
      `INSERT INTO consents
         (id, tenant_id, contact_id, channel, consent_state, recorded_at, updated_at,
          requested_at, request_token, request_count)
         VALUES (?, ?, ?, 'email', 'none', ?, ?, ?, ?, 1)
       ON CONFLICT(tenant_id, contact_id, channel) DO UPDATE SET
         requested_at  = excluded.requested_at,
         request_token = excluded.request_token,
         request_count = COALESCE(consents.request_count, 0) + 1,
         updated_at    = excluded.updated_at,
         consent_state = CASE WHEN consents.consent_state = 'granted' THEN 'granted'
                              WHEN consents.consent_state = 'revoked' THEN 'revoked'
                              ELSE 'none' END`,
    ).bind(uuidv4(), tenantId, r.id, now, now, now, token).run();

    // Build and enqueue the email — REAL send via Q_EMAIL_OUT, marked transactional.
    const messageId = uuidv4();
    const acceptUrl  = `https://${apiBase}/consent/${token}?action=accept`;
    const declineUrl = `https://${apiBase}/consent/${token}?action=decline`;
    const html = consentEmailHtml({
      contact_name: r.name,
      from_name:    sender.from_name,
      accept_url:   acceptUrl,
      decline_url:  declineUrl,
    });
    const subject = `Please confirm — ${sender.from_name} wants to email you`;

    await env.DB.prepare(
      `INSERT INTO messages
         (id, tenant_id, contact_id, channel, direction, subject, body_html, status, created_at, updated_at)
       VALUES (?, ?, ?, 'email', 'outbound', ?, ?, 'queued', ?, ?)`,
    ).bind(messageId, tenantId, r.id, subject, html, now, now).run();

    const payload: EmailOutPayload & { is_transactional?: boolean } = {
      id:              uuidv4(),
      type:            'email_out',
      tenant_id:       tenantId,
      attempt:         1,
      enqueued_at:     now,
      message_id:      messageId,
      contact_id:      r.id,
      oauth_token_id:  sender.oauth_token_id,
      to_email:        r.email,
      to_name:         r.name,
      from_email:      sender.from_email,
      from_name:       sender.from_name,
      subject,
      html_body:       html,
      tracking_domain: sender.tracking_domain,
      is_transactional: true,
    };
    await env.Q_EMAIL_OUT.send(payload);
    requested++;
  }

  return { requested, skipped_no_email: skipped, total_matched: matched.length };
}

async function signConsentToken(env: import('../env').ApiEnv, claims: Record<string, unknown>): Promise<string> {
  const secret = env.EMAIL_TRACK_KEY || env.JWT_SIGNING_KEY;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function consentEmailHtml(opts: { contact_name: string; from_name: string; accept_url: string; decline_url: string }): string {
  const safe = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html><body style="font-family:Arial,sans-serif;background:#f7f8fa;color:#0a0c0f;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 4px 18px rgba(15,23,42,0.06)">
    <h1 style="font-size:20px;margin:0 0 12px">May we email you?</h1>
    <p style="margin:0 0 16px;line-height:1.6;color:#333">Hi ${safe(opts.contact_name)},</p>
    <p style="margin:0 0 20px;line-height:1.6;color:#333">
      ${safe(opts.from_name)} would like your permission to send you future emails about
      our products, parts, and service updates. You can unsubscribe at any time.
    </p>
    <p style="margin:0 0 24px;text-align:center">
      <a href="${opts.accept_url}" style="display:inline-block;padding:12px 28px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Yes, please email me</a>
    </p>
    <p style="margin:0;text-align:center;font-size:13px">
      <a href="${opts.decline_url}" style="color:#6b7280;text-decoration:underline">No thanks, do not email me</a>
    </p>
    <hr style="margin:32px 0;border:0;border-top:1px solid #e5e7eb" />
    <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.5">
      If you don't recognise ${safe(opts.from_name)} or didn't expect this message, you can safely ignore it — we won't send marketing emails until you click "Yes" above.
    </p>
  </div>
</body></html>`;
}
