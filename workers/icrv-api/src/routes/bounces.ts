// workers/icrv-api/src/routes/bounces.ts
// Phase 5 — bounce + complaint management.
// /v1/bounces/clean → revokes consent for any contact whose bounce_count >= threshold

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import { loadSection } from './settings';

export function createBouncesRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/recent', async (c) => {
    const tenantId = c.get('tenant_id');
    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.contact_id, m.error, m.updated_at, c.email, c.name, c.bounce_count
         FROM messages m JOIN contacts c ON c.id = m.contact_id
        WHERE m.tenant_id = ? AND m.channel = 'email' AND m.status = 'failed'
        ORDER BY m.updated_at DESC LIMIT 100`,
    ).bind(tenantId).all<{
      id: string; contact_id: string; error: string;
      updated_at: string; email: string | null; name: string; bounce_count: number;
    }>();
    return c.json({ failures: rows.results ?? [] });
  });

  app.post('/clean', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const settings = await loadSection(c.env.DB, tenantId, 'bounce');
    const threshold = Number((settings.hard_bounce_threshold as number | undefined) ?? 3);
    const now = nowISO();

    const targets = await c.env.DB.prepare(
      `SELECT id FROM contacts WHERE tenant_id = ? AND COALESCE(bounce_count, 0) >= ?`,
    ).bind(tenantId, threshold).all<{ id: string }>();

    let revoked = 0;
    for (const t of targets.results ?? []) {
      await c.env.DB.prepare(
        `INSERT INTO consents (id, tenant_id, contact_id, channel, consent_state, recorded_at, updated_at)
         VALUES (?, ?, ?, 'email', 'revoked', ?, ?)
         ON CONFLICT(tenant_id, contact_id, channel)
         DO UPDATE SET consent_state='revoked', updated_at=excluded.updated_at`,
      ).bind(uuidv4(), tenantId, t.id, now, now).run();
      revoked++;
    }
    return c.json({ ok: true, threshold, revoked });
  });

  return app;
}
