// workers/icrv-api/src/routes/quotes.ts
// v2.7 — WhatsApp quotes CRUD + send.
//
//   GET    /v1/quotes                — list, filter by status / contact
//   GET    /v1/quotes/:id             — fetch one
//   POST   /v1/quotes                — create draft
//   PUT    /v1/quotes/:id             — update draft (line items, notes, etc.)
//   POST   /v1/quotes/:id/send        — render to WA template payload + enqueue Q_WA_OUT
//   POST   /v1/quotes/:id/status      — manual status flip (accepted | declined | expired)
//   DELETE /v1/quotes/:id             — delete drafts only
//
// Line item shape: { description, qty, unit_cents, total_cents }

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import type { WaOutPayload, WaTemplateComponent } from '@icrv/shared/types';
import { enqueueWebhooksForEvent } from './webhooks';

interface LineItem {
  description: string;
  qty:         number;
  unit_cents:  number;
  total_cents: number;
}

interface QuoteRow {
  id:              string;
  tenant_id:       string;
  contact_id:      string;
  quote_number:    string;
  status:          string;
  currency:        string;
  subtotal_cents:  number;
  tax_cents:       number;
  total_cents:     number;
  line_items_json: string;
  notes:           string | null;
  channel:         string;
  wa_message_id:   string | null;
  created_by:      string | null;
  created_at:      string;
  sent_at:         string | null;
  accepted_at:     string | null;
  expires_at:      string | null;
}

function shape(r: QuoteRow): Record<string, unknown> {
  return {
    id:             r.id,
    contact_id:     r.contact_id,
    quote_number:   r.quote_number,
    status:         r.status,
    currency:       r.currency,
    subtotal_cents: r.subtotal_cents,
    tax_cents:      r.tax_cents,
    total_cents:    r.total_cents,
    line_items:     safeJsonArr(r.line_items_json),
    notes:          r.notes ?? '',
    channel:        r.channel,
    wa_message_id:  r.wa_message_id ?? null,
    created_at:     r.created_at,
    sent_at:        r.sent_at,
    accepted_at:    r.accepted_at,
    expires_at:     r.expires_at,
  };
}

export function createQuotesRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/', async (c) => {
    const tenantId = c.get('tenant_id');
    const status = c.req.query('status')?.trim();
    const contactId = c.req.query('contact_id')?.trim();
    const where: string[] = ['tenant_id = ?'];
    const binds: unknown[] = [tenantId];
    if (status)    { where.push('status = ?');     binds.push(status); }
    if (contactId) { where.push('contact_id = ?'); binds.push(contactId); }
    const rows = await c.env.DB.prepare(
      `SELECT q.*, c.name AS contact_name, c.email AS contact_email, c.phone_e164 AS contact_phone
         FROM quotes q LEFT JOIN contacts c ON c.id = q.contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY q.created_at DESC LIMIT 200`,
    ).bind(...binds).all<QuoteRow & { contact_name: string | null; contact_email: string | null; contact_phone: string | null }>();
    return c.json({
      quotes: (rows.results ?? []).map((r) => ({
        ...shape(r),
        contact: { id: r.contact_id, name: r.contact_name, email: r.contact_email, phone: r.contact_phone },
      })),
    });
  });

  app.get('/:id', async (c) => {
    const r = await fetchQuote(c.env.DB, c.get('tenant_id'), c.req.param('id'));
    if (!r) return c.json({ error: 'not_found' }, 404);
    return c.json(shape(r));
  });

  app.post('/', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json<{
      contact_id: string; line_items: LineItem[]; notes?: string;
      currency?: string; tax_cents?: number; expires_at?: string;
    }>().catch(() => null);
    if (!body || !body.contact_id) return c.json({ error: 'contact_id_required' }, 400);
    const items = Array.isArray(body.line_items) ? body.line_items : [];
    const subtotal = items.reduce((sum, i) => sum + (Number.isFinite(i.total_cents) ? i.total_cents : 0), 0);
    const tax = Number.isFinite(body.tax_cents) ? Number(body.tax_cents) : 0;
    const total = subtotal + tax;
    const tenantId = c.get('tenant_id');
    const id = uuidv4();
    const number = await nextQuoteNumber(c.env.DB, tenantId);
    const now = nowISO();
    await c.env.DB.prepare(
      `INSERT INTO quotes
         (id, tenant_id, contact_id, quote_number, status, currency,
          subtotal_cents, tax_cents, total_cents, line_items_json, notes,
          channel, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?)`,
    ).bind(
      id, tenantId, body.contact_id, number,
      body.currency ?? 'USD',
      subtotal, tax, total,
      JSON.stringify(items), body.notes ?? null,
      c.get('user_id'), now, body.expires_at ?? null,
    ).run();
    const row = await fetchQuote(c.env.DB, tenantId, id);
    return c.json(shape(row!), 201);
  });

  app.put('/:id', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const cur = await fetchQuote(c.env.DB, tenantId, id);
    if (!cur) return c.json({ error: 'not_found' }, 404);
    if (cur.status !== 'draft') return c.json({ error: 'cannot_edit_after_send', status: cur.status }, 409);

    const body = await c.req.json<{
      line_items?: LineItem[]; notes?: string; currency?: string;
      tax_cents?: number; expires_at?: string;
    }>().catch(() => null) ?? {};

    const items = Array.isArray(body.line_items) ? body.line_items : safeJsonArr(cur.line_items_json) as LineItem[];
    const subtotal = items.reduce((sum, i) => sum + (Number.isFinite(i.total_cents) ? i.total_cents : 0), 0);
    const tax = Number.isFinite(body.tax_cents) ? Number(body.tax_cents) : cur.tax_cents;
    const total = subtotal + tax;
    await c.env.DB.prepare(
      `UPDATE quotes SET line_items_json=?, notes=?, currency=?, subtotal_cents=?, tax_cents=?,
         total_cents=?, expires_at=COALESCE(?, expires_at)
       WHERE id=? AND tenant_id=?`,
    ).bind(
      JSON.stringify(items), body.notes ?? cur.notes,
      body.currency ?? cur.currency, subtotal, tax, total,
      body.expires_at ?? null, id, tenantId,
    ).run();
    const row = await fetchQuote(c.env.DB, tenantId, id);
    return c.json(shape(row!));
  });

  app.delete('/:id', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const cur = await fetchQuote(c.env.DB, tenantId, id);
    if (!cur) return c.json({ error: 'not_found' }, 404);
    if (cur.status !== 'draft') return c.json({ error: 'cannot_delete_after_send', status: cur.status }, 409);
    await c.env.DB.prepare(`DELETE FROM quotes WHERE id=? AND tenant_id=?`).bind(id, tenantId).run();
    return c.json({ deleted: true });
  });

  app.post('/:id/status', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json<{ status: 'accepted' | 'declined' | 'expired' }>().catch(() => null);
    if (!body || !['accepted','declined','expired'].includes(body.status)) {
      return c.json({ error: 'invalid_status' }, 400);
    }
    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const cur = await fetchQuote(c.env.DB, tenantId, id);
    if (!cur) return c.json({ error: 'not_found' }, 404);
    const acceptedAt = body.status === 'accepted' ? nowISO() : cur.accepted_at;
    await c.env.DB.prepare(
      `UPDATE quotes SET status=?, accepted_at=? WHERE id=? AND tenant_id=?`,
    ).bind(body.status, acceptedAt, id, tenantId).run();
    const row = await fetchQuote(c.env.DB, tenantId, id);
    if (body.status === 'accepted') {
      await enqueueWebhooksForEvent(c.env, tenantId, 'quote_accepted', {
        quote_id: row!.id, quote_number: row!.quote_number, contact_id: row!.contact_id,
        total_cents: row!.total_cents, currency: row!.currency, accepted_at: row!.accepted_at,
      });
    }
    return c.json(shape(row!));
  });

  app.post('/:id/send', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const cur = await fetchQuote(c.env.DB, tenantId, id);
    if (!cur) return c.json({ error: 'not_found' }, 404);
    if (cur.status !== 'draft') return c.json({ error: 'already_sent', status: cur.status }, 409);

    // Resolve contact + active WhatsApp credential.
    const contact = await c.env.DB.prepare(
      `SELECT id, name, whatsapp_phone_e164 FROM contacts WHERE id=? AND tenant_id=?`,
    ).bind(cur.contact_id, tenantId).first<{ id: string; name: string; whatsapp_phone_e164: string | null }>();
    if (!contact || !contact.whatsapp_phone_e164) {
      return c.json({ error: 'contact_has_no_whatsapp_phone' }, 422);
    }
    const cred = await c.env.DB.prepare(
      `SELECT id FROM api_credentials WHERE tenant_id=? AND provider='whatsapp' AND is_active=1 LIMIT 1`,
    ).bind(tenantId).first<{ id: string }>();
    if (!cred) return c.json({ error: 'no_active_whatsapp_credential' }, 422);

    // Build a templated quote message. Template name is operator-configurable;
    // default `quote_summary` matches the WA template the operator must
    // register with Meta. Until approved by Meta, the queued send will fail
    // at the Meta API layer — surfaced via icrv-whatsapp logs / DLQ. We do
    // NOT silently succeed; we ENQUEUE a real send and update status to
    // 'sent' on enqueue success.
    const items = safeJsonArr(cur.line_items_json) as LineItem[];
    const itemsText = items.map((i, idx) => `${idx + 1}. ${i.description} — ${i.qty} × ${(i.unit_cents/100).toFixed(2)} = ${cur.currency} ${(i.total_cents/100).toFixed(2)}`).join('\n');
    const totalText = `${cur.currency} ${(cur.total_cents/100).toFixed(2)}`;
    const components: WaTemplateComponent[] = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: contact.name },
          { type: 'text', text: cur.quote_number },
          { type: 'text', text: itemsText.slice(0, 1024) },
          { type: 'text', text: totalText },
        ],
      },
    ];

    const messageId = uuidv4();
    const now = nowISO();
    await c.env.DB.prepare(
      `INSERT INTO messages
         (id, tenant_id, contact_id, channel, direction, body_text, status, created_at, updated_at)
       VALUES (?, ?, ?, 'whatsapp', 'outbound', ?, 'queued', ?, ?)`,
    ).bind(messageId, tenantId, contact.id, `Quote ${cur.quote_number}\n${itemsText}\nTotal ${totalText}`, now, now).run();

    const payload: WaOutPayload = {
      id:                  uuidv4(),
      type:                'wa_out',
      tenant_id:           tenantId,
      attempt:             1,
      enqueued_at:         now,
      message_id:          messageId,
      contact_id:          contact.id,
      credential_id:       cred.id,
      to_phone_e164:       contact.whatsapp_phone_e164,
      template_name:       'quote_summary',
      template_language:   'en',
      template_components: components,
    };
    await c.env.Q_WA_OUT.send(payload);

    await c.env.DB.prepare(
      `UPDATE quotes SET status='sent', sent_at=?, wa_message_id=? WHERE id=? AND tenant_id=?`,
    ).bind(now, messageId, id, tenantId).run();

    const row = await fetchQuote(c.env.DB, tenantId, id);
    await enqueueWebhooksForEvent(c.env, tenantId, 'quote_sent', {
      quote_id: row!.id, quote_number: row!.quote_number, contact_id: row!.contact_id,
      total_cents: row!.total_cents, currency: row!.currency, sent_at: row!.sent_at,
    });
    return c.json(shape(row!));
  });

  return app;
}

async function fetchQuote(db: D1Database, tenantId: string, id: string): Promise<QuoteRow | null> {
  return db.prepare(
    `SELECT * FROM quotes WHERE id=? AND tenant_id=?`,
  ).bind(id, tenantId).first<QuoteRow>();
}

async function nextQuoteNumber(db: D1Database, tenantId: string): Promise<string> {
  const yyyy = new Date().getUTCFullYear();
  const prefix = `Q-${yyyy}-`;
  const row = await db.prepare(
    `SELECT quote_number FROM quotes WHERE tenant_id=? AND quote_number LIKE ?
       ORDER BY quote_number DESC LIMIT 1`,
  ).bind(tenantId, `${prefix}%`).first<{ quote_number: string }>();
  let n = 1;
  if (row?.quote_number) {
    const tail = row.quote_number.slice(prefix.length);
    const parsed = parseInt(tail, 10);
    if (Number.isFinite(parsed)) n = parsed + 1;
  }
  return `${prefix}${String(n).padStart(4, '0')}`;
}

function safeJsonArr(s: string): unknown[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
