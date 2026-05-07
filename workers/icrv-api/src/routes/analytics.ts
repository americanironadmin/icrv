// workers/icrv-api/src/routes/analytics.ts
// Phase 4 — analytics dashboard endpoints.
//   GET /v1/analytics/overview?period=7|30|90|all
//   GET /v1/analytics/campaigns?period=...
//   GET /v1/analytics/opens-by-hour?period=...
//   GET /v1/analytics/email-status?period=...

import { Hono } from 'hono';
import type { HonoCtx } from '../env';

type Period = 7 | 30 | 90 | 0;

function parsePeriod(q: string | undefined): Period {
  switch (q) {
    case '7':  return 7;
    case '30': return 30;
    case '90': return 90;
    case 'all': return 0;
    default:   return 30;
  }
}

function periodCutoffSql(period: Period): string {
  if (period === 0) return `'1970-01-01'`;
  return `datetime('now','-${period} days')`;
}

export function createAnalyticsRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/overview', async (c) => {
    const tenantId = c.get('tenant_id');
    const period = parsePeriod(c.req.query('period'));
    const cutoff = periodCutoffSql(period);

    const sentRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages
         WHERE tenant_id=? AND channel='email' AND direction='outbound'
           AND status IN ('sent','delivered') AND COALESCE(sent_at, created_at) >= ${cutoff}`,
    ).bind(tenantId).first<{ n: number }>();
    const totalSent = sentRow?.n ?? 0;

    const eventsRow = await c.env.DB.prepare(
      `SELECT type, COUNT(*) AS n FROM tracking_events
         WHERE tenant_id=? AND occurred_at >= ${cutoff}
         GROUP BY type`,
    ).bind(tenantId).all<{ type: string; n: number }>();
    const events: Record<string, number> = {};
    for (const r of eventsRow.results ?? []) events[r.type] = r.n;

    const opens   = events.open   ?? 0;
    const clicks  = events.click  ?? 0;
    const bounces = events.bounce ?? 0;
    const unsubs  = events.unsubscribe ?? 0;

    const openRate    = totalSent > 0 ? (opens   / totalSent) * 100 : 0;
    const clickRate   = totalSent > 0 ? (clicks  / totalSent) * 100 : 0;
    const bounceRate  = totalSent > 0 ? (bounces / totalSent) * 100 : 0;
    const deliveryRate = totalSent > 0 ? Math.max(0, 100 - bounceRate) : 0;

    return c.json({
      period: period === 0 ? 'all' : period,
      total_sent:   totalSent,
      avg_open:     round1(openRate),
      avg_click:    round1(clickRate),
      delivery:     round1(deliveryRate),
      total_bounced: bounces,
      unsubscribed:  unsubs,
    });
  });

  app.get('/campaigns', async (c) => {
    const tenantId = c.get('tenant_id');
    const period = parsePeriod(c.req.query('period'));
    const cutoff = periodCutoffSql(period);

    const rows = await c.env.DB.prepare(
      `SELECT cmp.id, cmp.name, cmp.status, cmp.created_at,
              COUNT(DISTINCT m.id) AS sent,
              SUM(CASE WHEN te.type='open'  THEN 1 ELSE 0 END) AS opens,
              SUM(CASE WHEN te.type='click' THEN 1 ELSE 0 END) AS clicks,
              SUM(CASE WHEN te.type='bounce' THEN 1 ELSE 0 END) AS bounces
         FROM campaigns cmp
         LEFT JOIN messages m ON m.campaign_id = cmp.id
                              AND m.tenant_id = cmp.tenant_id
                              AND m.channel = 'email' AND m.direction='outbound'
                              AND COALESCE(m.sent_at, m.created_at) >= ${cutoff}
         LEFT JOIN tracking_events te ON te.campaign_id = cmp.id AND te.tenant_id = cmp.tenant_id
                                      AND te.occurred_at >= ${cutoff}
        WHERE cmp.tenant_id = ?
        GROUP BY cmp.id
        ORDER BY cmp.created_at DESC
        LIMIT 50`,
    ).bind(tenantId).all<{
      id: string; name: string; status: string; created_at: string;
      sent: number; opens: number; clicks: number; bounces: number;
    }>();
    return c.json({ campaigns: (rows.results ?? []).map((r) => ({
      ...r,
      open_rate:  r.sent ? round1((r.opens  / r.sent) * 100) : 0,
      click_rate: r.sent ? round1((r.clicks / r.sent) * 100) : 0,
    })) });
  });

  app.get('/opens-by-hour', async (c) => {
    const tenantId = c.get('tenant_id');
    const period = parsePeriod(c.req.query('period'));
    const cutoff = periodCutoffSql(period);

    const rows = await c.env.DB.prepare(
      `SELECT CAST(strftime('%H', occurred_at) AS INTEGER) AS hour, COUNT(*) AS n
         FROM tracking_events
        WHERE tenant_id = ? AND type = 'open' AND occurred_at >= ${cutoff}
        GROUP BY hour ORDER BY hour`,
    ).bind(tenantId).all<{ hour: number; n: number }>();
    const buckets = Array.from({ length: 24 }, (_, i) => ({ hour: i, opens: 0 }));
    for (const r of rows.results ?? []) buckets[r.hour].opens = r.n;
    return c.json({ buckets });
  });

  app.get('/email-status', async (c) => {
    const tenantId = c.get('tenant_id');
    const period = parsePeriod(c.req.query('period'));
    const cutoff = periodCutoffSql(period);

    const rows = await c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM messages
         WHERE tenant_id=? AND channel='email' AND direction='outbound'
           AND COALESCE(sent_at, created_at) >= ${cutoff}
         GROUP BY status`,
    ).bind(tenantId).all<{ status: string; n: number }>();
    return c.json({ statuses: rows.results ?? [] });
  });

  return app;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
