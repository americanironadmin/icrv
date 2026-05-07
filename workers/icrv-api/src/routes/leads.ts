// workers/icrv-api/src/routes/leads.ts
// Phase 4 — lead intelligence endpoints.
//   GET  /v1/leads/intelligence     dashboard tiles + top hot/warm
//   GET  /v1/leads/ranked           paginated all-leads table
//   POST /v1/leads/recalculate-all  re-score every contact for the tenant
//
// Recalculation runs inline (Workers CPU budget is generous; 50k contacts at
// ~3 SQL queries each fits well under a single tick). Larger tenants should
// be moved to a Q_AGENT job in a future iteration.

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import {
  calculateLeadScore,
  type ActivityCounts,
  type Demographics,
} from '@icrv/shared/scoring';
import { nowISO } from '@icrv/shared/crypto';

interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  country_code: string | null;
  industry: string | null;
  tags_json: string | null;
}

export function createLeadsRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  // Dashboard tiles
  app.get('/intelligence', async (c) => {
    const tenantId = c.get('tenant_id');
    const counts = await c.env.DB.prepare(
      `SELECT category, COUNT(*) AS n FROM lead_scores WHERE tenant_id=? GROUP BY category`,
    ).bind(tenantId).all<{ category: string; n: number }>();
    const byCat: Record<string, number> = { hot: 0, warm: 0, cold: 0 };
    for (const r of counts.results ?? []) byCat[r.category] = r.n;

    const top = async (cat: 'hot' | 'warm', limit = 10) => {
      const rows = await c.env.DB.prepare(
        `SELECT s.contact_id, s.score, c.name, c.email, c.country_code, c.industry
           FROM lead_scores s JOIN contacts c ON c.id = s.contact_id
          WHERE s.tenant_id = ? AND s.category = ?
          ORDER BY s.score DESC LIMIT ?`,
      ).bind(tenantId, cat, limit).all<{
        contact_id: string; score: number; name: string;
        email: string | null; country_code: string | null; industry: string | null;
      }>();
      return rows.results ?? [];
    };

    const [hot, warm] = await Promise.all([top('hot'), top('warm')]);

    return c.json({
      counts: {
        hot:  byCat.hot  ?? 0,
        warm: byCat.warm ?? 0,
        cold: byCat.cold ?? 0,
        total: (byCat.hot ?? 0) + (byCat.warm ?? 0) + (byCat.cold ?? 0),
      },
      top_hot:  hot,
      top_warm: warm,
      weights: { engagement: 35, demographics: 25, behavioral: 20, tags: 20 },
    });
  });

  // Ranked table — paginated, filterable by category.
  app.get('/ranked', async (c) => {
    const tenantId = c.get('tenant_id');
    const category = (c.req.query('category') ?? '').toLowerCase();
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
    const perPage = Math.min(200, Math.max(1, parseInt(c.req.query('per_page') ?? '25', 10)));
    const offset = (page - 1) * perPage;

    const where = ['s.tenant_id = ?'];
    const binds: unknown[] = [tenantId];
    if (['hot', 'warm', 'cold'].includes(category)) {
      where.push('s.category = ?');
      binds.push(category);
    }

    const total = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lead_scores s WHERE ${where.join(' AND ')}`,
    ).bind(...binds).first<{ n: number }>())?.n ?? 0;

    const rows = await c.env.DB.prepare(
      `SELECT s.contact_id, s.score, s.category, s.engagement_score, s.demographic_score,
              s.behavioral_score, s.tag_score, s.last_calculated,
              c.name, c.email, c.country_code, c.industry, c.tags_json
         FROM lead_scores s
         JOIN contacts c ON c.id = s.contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.score DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, perPage, offset).all<{
      contact_id: string; score: number; category: string;
      engagement_score: number; demographic_score: number; behavioral_score: number; tag_score: number;
      last_calculated: string; name: string; email: string | null;
      country_code: string | null; industry: string | null; tags_json: string | null;
    }>();

    return c.json({
      total, page, per_page: perPage,
      leads: (rows.results ?? []).map((r) => ({
        contact_id: r.contact_id,
        name:       r.name,
        email:      r.email,
        country:    r.country_code,
        industry:   r.industry,
        score:      r.score,
        category:   r.category,
        engagement: r.engagement_score,
        demographic: r.demographic_score,
        behavioral: r.behavioral_score,
        tag:        r.tag_score,
        tags:       r.tags_json ? JSON.parse(r.tags_json) as string[] : [],
        last_calculated: r.last_calculated,
      })),
    });
  });

  // Recalculate all — admin only.
  app.post('/recalculate-all', async (c) => {
    if (c.get('user_role') !== 'admin' && c.get('user_role') !== 'operator') {
      return c.json({ error: 'forbidden' }, 403);
    }
    const tenantId = c.get('tenant_id');
    const updated = await recalculateAll(c.env.DB, tenantId);
    return c.json({ ok: true, updated });
  });

  // Per-contact recalc (e.g. after manual tag edit).
  app.post('/:contactId/recalculate', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const id = c.req.param('contactId');
    const score = await recalculateContact(c.env.DB, tenantId, id);
    if (!score) return c.json({ error: 'not_found' }, 404);
    return c.json(score);
  });

  return app;
}

// ─── Reusable scoring routines (also called from cron + on activity) ──────

export async function recalculateAll(db: D1Database, tenantId: string): Promise<number> {
  const contacts = await db.prepare(
    `SELECT id, name, email, country_code, industry, tags_json
       FROM contacts WHERE tenant_id = ?`,
  ).bind(tenantId).all<ContactRow>();
  let n = 0;
  for (const c of contacts.results ?? []) {
    await scoreOne(db, tenantId, c);
    n++;
  }
  return n;
}

export async function recalculateContact(
  db: D1Database, tenantId: string, contactId: string,
): Promise<ReturnType<typeof calculateLeadScore> | null> {
  const c = await db.prepare(
    `SELECT id, name, email, country_code, industry, tags_json
       FROM contacts WHERE id = ? AND tenant_id = ?`,
  ).bind(contactId, tenantId).first<ContactRow>();
  if (!c) return null;
  return scoreOne(db, tenantId, c);
}

async function scoreOne(
  db: D1Database, tenantId: string, c: ContactRow,
): Promise<ReturnType<typeof calculateLeadScore>> {
  const activity = await fetchActivity(db, tenantId, c.id);
  const tags: string[] = c.tags_json ? safeJsonArray(c.tags_json) : [];
  const demographics: Demographics = {
    country: c.country_code ?? undefined,
    industry: c.industry ?? undefined,
  };
  const score = calculateLeadScore(activity, demographics, tags);
  await db.prepare(
    `INSERT INTO lead_scores
       (contact_id, tenant_id, score, category, engagement_score, demographic_score, behavioral_score, tag_score, last_calculated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET
       score=excluded.score, category=excluded.category,
       engagement_score=excluded.engagement_score,
       demographic_score=excluded.demographic_score,
       behavioral_score=excluded.behavioral_score,
       tag_score=excluded.tag_score,
       last_calculated=excluded.last_calculated`,
  ).bind(
    c.id, tenantId, score.score, score.category,
    score.engagement, score.demographic, score.behavioral, score.tag,
    nowISO(),
  ).run();
  return score;
}

async function fetchActivity(db: D1Database, tenantId: string, contactId: string): Promise<ActivityCounts> {
  // Open / click / reply pulled from tracking_events + message_events.
  const trackRows = await db.prepare(
    `SELECT type, COUNT(*) AS n FROM tracking_events
       WHERE tenant_id = ? AND contact_id = ?
       GROUP BY type`,
  ).bind(tenantId, contactId).all<{ type: string; n: number }>();
  const trackMap: Record<string, number> = {};
  for (const r of trackRows.results ?? []) trackMap[r.type] = r.n;

  const repliedRow = await db.prepare(
    `SELECT COUNT(*) AS n FROM message_events e
       JOIN messages m ON m.id = e.message_id
      WHERE m.tenant_id = ? AND m.contact_id = ? AND e.event_type = 'replied'`,
  ).bind(tenantId, contactId).first<{ n: number }>();

  const recentRow = await db.prepare(
    `SELECT MAX(occurred_at) AS last FROM tracking_events
       WHERE tenant_id = ? AND contact_id = ?`,
  ).bind(tenantId, contactId).first<{ last: string | null }>();
  const lastTs = recentRow?.last ? new Date(recentRow.last).getTime() : 0;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const last_activity_within_7d = lastTs > 0 && Date.now() - lastTs < sevenDays;

  return {
    opens:  trackMap.open  ?? 0,
    clicks: trackMap.click ?? 0,
    replies: repliedRow?.n ?? 0,
    website_visits:   0,   // not yet tracked; reserved for future site pixel
    form_submissions: 0,   // reserved for future form integration
    last_activity_within_7d,
  };
}

function safeJsonArray(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
}
