// workers/icrv-consumer/src/import-processor.ts
// Phase 1A — bulk contact import consumer.
//
// Streams CSV from R2 in 500-row chunks, upserts contacts on
// (tenant_id, email), updates progress in D1 every batch. Designed to
// finish within the worker CPU budget for the 25MB / ~250k-row case.
// Errors are accumulated (capped at 100 reported).

import type { BaseEnv, ImportJobPayload } from '@icrv/shared/types';
import { uuidv4, nowISO } from '@icrv/shared/crypto';

const E164  = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHUNK = 500;

interface ImportRow {
  name?: string; email?: string; phone?: string; whatsapp_phone?: string;
  tags?: string; consent_email?: string; consent_whatsapp?: string; consent_voice?: string;
}

export async function processImportJob(p: ImportJobPayload, env: BaseEnv): Promise<void> {
  const { job_id, tenant_id } = p;
  const startISO = nowISO();

  // Mark processing
  await env.DB.prepare(
    `UPDATE import_jobs SET status='processing', updated_at=? WHERE id=? AND tenant_id=?`,
  ).bind(startISO, job_id, tenant_id).run();

  const obj = await env.R2_UPLOADS.get(p.r2_key);
  if (!obj) {
    await markFailed(env, job_id, tenant_id, 'r2_object_missing');
    return;
  }
  const csvText = await obj.text();

  const { rows, headers } = parseCsv(csvText);
  if (!headers.includes('name')) {
    await env.DB.prepare(
      `UPDATE import_jobs SET status='failed', errors_json=?, total_rows=?, updated_at=?, completed_at=? WHERE id=? AND tenant_id=?`,
    ).bind(JSON.stringify([{ row: 0, reason: 'missing_header:name' }]), rows.length, nowISO(), nowISO(), job_id, tenant_id).run();
    return;
  }

  const total = rows.length;
  await env.DB.prepare(
    `UPDATE import_jobs SET total_rows=?, updated_at=? WHERE id=? AND tenant_id=?`,
  ).bind(total, nowISO(), job_id, tenant_id).run();

  let accepted = 0, rejected = 0, processed = 0;
  const errors: Array<{ row: number; reason: string }> = [];

  for (let start = 0; start < rows.length; start += CHUNK) {
    const slice = rows.slice(start, start + CHUNK);
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i] as unknown as ImportRow;
      const rowNum = start + i + 2; // +2 because row 1 is header
      try {
        const name = r.name?.trim();
        if (!name) throw new Error('name_required');
        const email = r.email?.trim() || null;
        const phone = r.phone?.trim() || null;
        const wa    = r.whatsapp_phone?.trim() || null;
        if (email && !EMAIL.test(email)) throw new Error('email_invalid');
        if (phone && !E164.test(phone)) throw new Error('phone_must_be_e164');
        if (wa && !E164.test(wa))       throw new Error('whatsapp_phone_must_be_e164');

        // Upsert on (tenant_id, email) when email present, else INSERT.
        // contacts has no UNIQUE on (tenant_id, email) yet — emulate by lookup.
        const cid = uuidv4();
        const now = nowISO();
        const tagsJson = r.tags ? JSON.stringify(r.tags.split('|').map(s => s.trim()).filter(Boolean)) : null;

        if (email) {
          const existing = await env.DB.prepare(
            `SELECT id FROM contacts WHERE tenant_id = ? AND email = ? LIMIT 1`,
          ).bind(tenant_id, email).first<{ id: string }>();
          if (existing) {
            await env.DB.prepare(
              `UPDATE contacts SET name=?, phone_e164=COALESCE(?, phone_e164),
                                   whatsapp_phone_e164=COALESCE(?, whatsapp_phone_e164),
                                   tags_json=COALESCE(?, tags_json), updated_at=?
               WHERE id=? AND tenant_id=?`,
            ).bind(name, phone, wa, tagsJson, now, existing.id, tenant_id).run();
            await upsertConsents(env.DB, tenant_id, existing.id, r, now);
            accepted++;
            continue;
          }
        }

        await env.DB.prepare(
          `INSERT INTO contacts (id, tenant_id, name, email, phone_e164, whatsapp_phone_e164, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(cid, tenant_id, name, email, phone, wa, tagsJson, now, now).run();
        await upsertConsents(env.DB, tenant_id, cid, r, now);
        accepted++;
      } catch (err) {
        rejected++;
        if (errors.length < 100) errors.push({ row: rowNum, reason: (err as Error).message });
      }
    }
    processed = Math.min(rows.length, start + CHUNK);

    // Update progress every batch
    await env.DB.prepare(
      `UPDATE import_jobs SET processed_rows=?, accepted=?, rejected=?, errors_json=?, updated_at=?
       WHERE id=? AND tenant_id=?`,
    ).bind(processed, accepted, rejected, JSON.stringify(errors), nowISO(), job_id, tenant_id).run();
  }

  await env.DB.prepare(
    `UPDATE import_jobs SET status='completed', processed_rows=?, accepted=?, rejected=?, errors_json=?,
                            updated_at=?, completed_at=? WHERE id=? AND tenant_id=?`,
  ).bind(total, accepted, rejected, JSON.stringify(errors), nowISO(), nowISO(), job_id, tenant_id).run();
}

async function markFailed(env: BaseEnv, jobId: string, tenantId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE import_jobs SET status='failed', errors_json=?, updated_at=?, completed_at=? WHERE id=? AND tenant_id=?`,
  ).bind(JSON.stringify([{ row: 0, reason }]), nowISO(), nowISO(), jobId, tenantId).run();
}

async function upsertConsents(
  db: D1Database, tenantId: string, contactId: string, r: ImportRow, now: string,
): Promise<void> {
  const channels: Array<['email'|'whatsapp'|'voice', string|undefined]> = [
    ['email',    r.consent_email],
    ['whatsapp', r.consent_whatsapp],
    ['voice',    r.consent_voice],
  ];
  for (const [ch, val] of channels) {
    if (val == null || val === '') continue;
    const state = /^(1|true|yes|y|granted)$/i.test(val.trim()) ? 'granted' : 'revoked';
    await db.prepare(
      `INSERT INTO consents (id, tenant_id, contact_id, channel, consent_state, recorded_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, contact_id, channel)
       DO UPDATE SET consent_state=excluded.consent_state, updated_at=excluded.updated_at`,
    ).bind(uuidv4(), tenantId, contactId, ch, state, now, now).run();
  }
}

// ─── CSV parser (RFC-4180 light, supports quoted fields) ────────────────────

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
