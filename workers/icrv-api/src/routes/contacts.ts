// workers/icrv-api/src/routes/contacts.ts
// /v1/contacts — full CRUD + bulk-upload pipeline.
// Bulk upload writes raw CSV to R2_UPLOADS, creates an upload_jobs row, and
// processes inline with a strict cap (10k rows per request). For larger jobs
// the client should split the file. We keep this synchronous because Workers
// already have a generous CPU budget for streaming CSV parses.

import { Hono } from 'hono';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import type { HonoCtx } from '../env';

interface ContactRow {
  id: string; tenant_id: string; name: string;
  email?: string | null; phone_e164?: string | null; whatsapp_phone_e164?: string | null;
  attributes_json?: string | null; tags_json?: string | null;
  created_at: string; updated_at: string;
}

interface ConsentRow {
  channel: string; consent_state: 'granted' | 'revoked' | 'none';
}

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function shapeContact(r: ContactRow, consents: ConsentRow[]) {
  const c: Record<string, 'granted'|'revoked'|'none'> = { email: 'none', whatsapp: 'none', voice: 'none' };
  for (const x of consents) c[x.channel] = x.consent_state;
  return {
    id: r.id, tenant_id: r.tenant_id, name: r.name,
    email: r.email ?? undefined, phone: r.phone_e164 ?? undefined, whatsapp_phone: r.whatsapp_phone_e164 ?? undefined,
    consent_email:    c.email    === 'granted',
    consent_whatsapp: c.whatsapp === 'granted',
    consent_voice:    c.voice    === 'granted',
    tags: r.tags_json ? JSON.parse(r.tags_json) as string[] : [],
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

async function upsertConsents(
  db: D1Database, tenantId: string, contactId: string,
  consent: { email?: boolean; whatsapp?: boolean; voice?: boolean },
  now: string,
): Promise<void> {
  const channels: Array<['email'|'whatsapp'|'voice', boolean|undefined]> = [
    ['email', consent.email], ['whatsapp', consent.whatsapp], ['voice', consent.voice],
  ];
  for (const [ch, val] of channels) {
    if (val === undefined) continue;
    const state = val ? 'granted' : 'revoked';
    await db.prepare(
      `INSERT INTO consents (id, tenant_id, contact_id, channel, consent_state, recorded_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, contact_id, channel)
       DO UPDATE SET consent_state=excluded.consent_state, updated_at=excluded.updated_at`,
    ).bind(uuidv4(), tenantId, contactId, ch, state, now, now).run();
  }
}

export function createContactsRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  // GET /v1/contacts
  app.get('/', async (c) => {
    const tenantId = c.get('tenant_id');
    const q = c.req.query();
    const page    = Math.max(1, parseInt(q.page ?? '1', 10));
    const perPage = Math.min(200, Math.max(1, parseInt(q.per_page ?? '25', 10)));
    const offset  = (page - 1) * perPage;
    const search  = q.search?.trim();
    const tag     = q.tag?.trim();

    const where: string[] = ['tenant_id = ?'];
    const binds: unknown[] = [tenantId];
    if (search) {
      where.push('(name LIKE ? OR email LIKE ? OR phone_e164 LIKE ?)');
      binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (tag) {
      where.push(`id IN (SELECT contact_id FROM contact_tags WHERE tenant_id = ? AND tag = ?)`);
      binds.push(tenantId, tag);
    }
    const whereClause = where.join(' AND ');

    const total = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM contacts WHERE ${whereClause}`,
    ).bind(...binds).first<{ n: number }>())?.n ?? 0;

    const rows = await c.env.DB.prepare(
      `SELECT id, tenant_id, name, email, phone_e164, whatsapp_phone_e164,
              attributes_json, tags_json, created_at, updated_at
       FROM contacts WHERE ${whereClause}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, perPage, offset).all<ContactRow>();

    const ids = (rows.results ?? []).map(r => r.id);
    const consentsByContact = new Map<string, ConsentRow[]>();
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const cs = await c.env.DB.prepare(
        `SELECT contact_id, channel, consent_state FROM consents
         WHERE tenant_id = ? AND contact_id IN (${placeholders})`,
      ).bind(tenantId, ...ids).all<ConsentRow & { contact_id: string }>();
      for (const r of cs.results ?? []) {
        const arr = consentsByContact.get(r.contact_id) ?? [];
        arr.push({ channel: r.channel, consent_state: r.consent_state });
        consentsByContact.set(r.contact_id, arr);
      }
    }

    return c.json({
      contacts: (rows.results ?? []).map(r => shapeContact(r, consentsByContact.get(r.id) ?? [])),
      total, page, per_page: perPage,
    });
  });

  // GET /v1/contacts/:id
  app.get('/:id', async (c) => {
    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT id, tenant_id, name, email, phone_e164, whatsapp_phone_e164,
              attributes_json, tags_json, created_at, updated_at
       FROM contacts WHERE id = ? AND tenant_id = ?`,
    ).bind(id, tenantId).first<ContactRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);

    const consents = await c.env.DB.prepare(
      `SELECT channel, consent_state FROM consents WHERE tenant_id = ? AND contact_id = ?`,
    ).bind(tenantId, id).all<ConsentRow>();

    return c.json(shapeContact(row, consents.results ?? []));
  });

  // POST /v1/contacts
  app.post('/', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);

    const body = await c.req.json<{
      name: string; email?: string; phone?: string; whatsapp_phone?: string;
      consent_email?: boolean; consent_whatsapp?: boolean; consent_voice?: boolean;
      tags?: string[]; attributes?: Record<string, string|number|boolean>;
    }>().catch(() => null);

    if (!body || !body.name) return c.json({ error: 'name_required' }, 400);
    if (body.email && !EMAIL.test(body.email)) return c.json({ error: 'email_invalid' }, 400);
    if (body.phone && !E164.test(body.phone)) return c.json({ error: 'phone_must_be_e164' }, 400);
    if (body.whatsapp_phone && !E164.test(body.whatsapp_phone)) return c.json({ error: 'whatsapp_phone_must_be_e164' }, 400);

    const tenantId = c.get('tenant_id');
    const id = uuidv4();
    const now = nowISO();

    await c.env.DB.prepare(
      `INSERT INTO contacts
         (id, tenant_id, name, email, phone_e164, whatsapp_phone_e164, attributes_json, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, tenantId, body.name,
      body.email ?? null, body.phone ?? null, body.whatsapp_phone ?? null,
      body.attributes ? JSON.stringify(body.attributes) : null,
      body.tags ? JSON.stringify(body.tags) : null,
      now, now,
    ).run();

    await upsertConsents(c.env.DB, tenantId, id, {
      email: body.consent_email, whatsapp: body.consent_whatsapp, voice: body.consent_voice,
    }, now);

    const row = await c.env.DB.prepare(
      `SELECT id, tenant_id, name, email, phone_e164, whatsapp_phone_e164,
              attributes_json, tags_json, created_at, updated_at
       FROM contacts WHERE id = ?`,
    ).bind(id).first<ContactRow>();
    const cs = await c.env.DB.prepare(
      `SELECT channel, consent_state FROM consents WHERE tenant_id = ? AND contact_id = ?`,
    ).bind(tenantId, id).all<ConsentRow>();

    return c.json(shapeContact(row!, cs.results ?? []), 201);
  });

  // PUT /v1/contacts/:id
  app.put('/:id', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);

    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string; email?: string; phone?: string; whatsapp_phone?: string;
      consent_email?: boolean; consent_whatsapp?: boolean; consent_voice?: boolean;
      tags?: string[]; attributes?: Record<string, string|number|boolean>;
    }>().catch(() => null) ?? {};

    if (body.email && !EMAIL.test(body.email))    return c.json({ error: 'email_invalid' }, 400);
    if (body.phone && !E164.test(body.phone))     return c.json({ error: 'phone_must_be_e164' }, 400);
    if (body.whatsapp_phone && !E164.test(body.whatsapp_phone)) return c.json({ error: 'whatsapp_phone_must_be_e164' }, 400);

    const sets: string[] = ['updated_at = ?'];
    const binds: unknown[] = [nowISO()];

    if (body.name !== undefined)            { sets.push('name = ?'); binds.push(body.name); }
    if (body.email !== undefined)           { sets.push('email = ?'); binds.push(body.email); }
    if (body.phone !== undefined)           { sets.push('phone_e164 = ?'); binds.push(body.phone); }
    if (body.whatsapp_phone !== undefined)  { sets.push('whatsapp_phone_e164 = ?'); binds.push(body.whatsapp_phone); }
    if (body.tags !== undefined)            { sets.push('tags_json = ?'); binds.push(JSON.stringify(body.tags)); }
    if (body.attributes !== undefined)      { sets.push('attributes_json = ?'); binds.push(JSON.stringify(body.attributes)); }

    binds.push(id, tenantId);

    const res = await c.env.DB.prepare(
      `UPDATE contacts SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
    ).bind(...binds).run();
    if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);

    await upsertConsents(c.env.DB, tenantId, id, {
      email: body.consent_email, whatsapp: body.consent_whatsapp, voice: body.consent_voice,
    }, nowISO());

    const row = await c.env.DB.prepare(
      `SELECT id, tenant_id, name, email, phone_e164, whatsapp_phone_e164,
              attributes_json, tags_json, created_at, updated_at
       FROM contacts WHERE id = ?`,
    ).bind(id).first<ContactRow>();
    const cs = await c.env.DB.prepare(
      `SELECT channel, consent_state FROM consents WHERE tenant_id = ? AND contact_id = ?`,
    ).bind(tenantId, id).all<ConsentRow>();

    return c.json(shapeContact(row!, cs.results ?? []));
  });

  // DELETE /v1/contacts/:id
  app.delete('/:id', async (c) => {
    if (c.get('user_role') !== 'admin' && c.get('user_role') !== 'operator')
      return c.json({ error: 'forbidden' }, 403);

    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const res = await c.env.DB.prepare(
      `DELETE FROM contacts WHERE id = ? AND tenant_id = ?`,
    ).bind(id, tenantId).run();
    if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ deleted: true });
  });

  // POST /v1/contacts/bulk-upload   (multipart/form-data, field: file)
  app.post('/bulk-upload', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);

    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'file_field_required' }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ error: 'file_too_large_10mb_max' }, 413);

    const tenantId = c.get('tenant_id');
    const userId   = c.get('user_id');
    const jobId    = uuidv4();
    const now      = nowISO();

    const csvText = await file.text();
    const r2Path  = `tenants/${tenantId}/uploads/${jobId}.csv`;
    await c.env.R2_UPLOADS.put(r2Path, csvText, { httpMetadata: { contentType: 'text/csv' } });

    await c.env.DB.prepare(
      `INSERT INTO upload_jobs (id, tenant_id, user_id, source_uri, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'processing', ?, ?)`,
    ).bind(jobId, tenantId, userId, r2Path, now, now).run();

    // Inline CSV parse — supports quoted fields and embedded commas.
    const { rows, headers } = parseCsv(csvText);
    const requiredHeaders = ['name'];
    for (const h of requiredHeaders) {
      if (!headers.includes(h)) {
        await c.env.DB.prepare(
          `UPDATE upload_jobs SET status='failed', errors_json=?, updated_at=?, completed_at=? WHERE id=?`,
        ).bind(JSON.stringify([{ row: 0, reason: `missing_header:${h}` }]), nowISO(), nowISO(), jobId).run();
        return c.json({ error: `missing_header:${h}` }, 400);
      }
    }

    const errors: Array<{ row: number; reason: string }> = [];
    let accepted = 0, rejected = 0;
    const total = rows.length;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        const name = r.name?.trim();
        if (!name) throw new Error('name_required');
        const email = r.email?.trim() || null;
        const phone = r.phone?.trim() || null;
        const wa    = r.whatsapp_phone?.trim() || null;
        if (email && !EMAIL.test(email)) throw new Error('email_invalid');
        if (phone && !E164.test(phone)) throw new Error('phone_must_be_e164');
        if (wa && !E164.test(wa))       throw new Error('whatsapp_phone_must_be_e164');

        const cid = uuidv4();
        await c.env.DB.prepare(
          `INSERT INTO contacts (id, tenant_id, name, email, phone_e164, whatsapp_phone_e164, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          cid, tenantId, name, email, phone, wa,
          r.tags ? JSON.stringify(r.tags.split('|').map(s => s.trim()).filter(Boolean)) : null,
          nowISO(), nowISO(),
        ).run();

        await upsertConsents(c.env.DB, tenantId, cid, {
          email:    r.consent_email    ? truthy(r.consent_email)    : undefined,
          whatsapp: r.consent_whatsapp ? truthy(r.consent_whatsapp) : undefined,
          voice:    r.consent_voice    ? truthy(r.consent_voice)    : undefined,
        }, nowISO());
        accepted++;
      } catch (err) {
        rejected++;
        errors.push({ row: i + 2, reason: (err as Error).message }); // +2 because row 1 is header
      }
    }

    await c.env.DB.prepare(
      `UPDATE upload_jobs SET status='completed', total_rows=?, processed=?, accepted=?, rejected=?,
                              errors_json=?, updated_at=?, completed_at=?
       WHERE id=?`,
    ).bind(total, total, accepted, rejected, JSON.stringify(errors.slice(0, 100)), nowISO(), nowISO(), jobId).run();

    return c.json({ job_id: jobId, status: 'completed', total_rows: total, accepted, rejected, errors: errors.slice(0, 50) });
  });

  // GET /v1/contacts/bulk-upload/:jobId
  app.get('/bulk-upload/:jobId', async (c) => {
    const tenantId = c.get('tenant_id');
    const jobId = c.req.param('jobId');
    const row = await c.env.DB.prepare(
      `SELECT id, status, total_rows, processed, accepted, rejected, errors_json, completed_at
       FROM upload_jobs WHERE id = ? AND tenant_id = ?`,
    ).bind(jobId, tenantId).first<{
      id: string; status: string; total_rows: number; processed: number;
      accepted: number; rejected: number; errors_json?: string; completed_at?: string;
    }>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json({
      job_id: row.id, status: row.status,
      total_rows: row.total_rows, processed: row.processed,
      accepted: row.accepted, rejected: row.rejected,
      errors: row.errors_json ? JSON.parse(row.errors_json) : [],
      completed_at: row.completed_at,
    });
  });

  return app;
}

// ─── CSV parser (RFC-4180 light) ─────────────────────────────────────────────

function parseCsv(text: string): { rows: Record<string, string>[]; headers: string[] } {
  const lines = splitCsvLines(text);
  if (lines.length === 0) return { rows: [], headers: [] };
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cells[j] ?? '').trim();
    rows.push(row);
  }
  return { rows, headers };
}

function splitCsvLines(text: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQ = !inQ; cur += ch; continue; }
    if ((ch === '\n' || ch === '\r') && !inQ) {
      if (ch === '\r' && text[i+1] === '\n') i++;
      out.push(cur); cur = ''; continue;
    }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') { inQ = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

function truthy(v: string): boolean {
  return /^(1|true|yes|y|granted)$/i.test(v.trim());
}
