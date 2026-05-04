// workers/icrv-api/src/routes/campaigns.ts
// /v1/campaigns and /v1/templates routes.

import { Hono } from 'hono';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import type { HonoCtx } from '../env';

interface CampaignRow {
  id: string; tenant_id: string; name: string; description?: string|null;
  channel: string; status: string; goal?: string|null; audience_filter?: string|null;
  enrolled_count: number; sent_count: number; opened_count: number;
  clicked_count: number; replied_count: number; failed_count: number;
  created_at: string; updated_at: string; launched_at?: string|null; completed_at?: string|null;
}
interface StepRow {
  id: string; campaign_id: string; step_index: number; channel: string;
  template_id?: string|null; credential_id?: string|null; delay_hours: number;
}

async function campaignWithSteps(db: D1Database, c: CampaignRow): Promise<unknown> {
  const steps = await db.prepare(
    `SELECT id, campaign_id, step_index, channel, template_id, credential_id, delay_hours
     FROM campaign_steps WHERE campaign_id = ? ORDER BY step_index ASC`,
  ).bind(c.id).all<StepRow>();
  return {
    id: c.id, tenant_id: c.tenant_id, name: c.name,
    description: c.description ?? undefined, channel: c.channel, status: c.status,
    audience_filter: c.audience_filter ? JSON.parse(c.audience_filter) : undefined,
    steps: (steps.results ?? []).map(s => ({
      id: s.id, step_index: s.step_index, channel: s.channel,
      template_id: s.template_id ?? '', credential_id: s.credential_id ?? '',
      delay_hours: s.delay_hours,
    })),
    enrolled_count: c.enrolled_count, sent_count: c.sent_count, opened_count: c.opened_count,
    clicked_count: c.clicked_count, replied_count: c.replied_count, failed_count: c.failed_count,
    created_at: c.created_at, updated_at: c.updated_at,
    launched_at: c.launched_at ?? undefined, completed_at: c.completed_at ?? undefined,
  };
}

export function createCampaignsRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/', async (c) => {
    const tenantId = c.get('tenant_id');
    const q = c.req.query();
    const page    = Math.max(1, parseInt(q.page ?? '1', 10));
    const perPage = Math.min(200, Math.max(1, parseInt(q.per_page ?? '25', 10)));
    const where: string[] = ['tenant_id = ?']; const binds: unknown[] = [tenantId];
    if (q.status)  { where.push('status = ?');  binds.push(q.status);  }
    if (q.channel) { where.push('channel = ?'); binds.push(q.channel); }
    const total = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM campaigns WHERE ${where.join(' AND ')}`)
      .bind(...binds).first<{ n: number }>())?.n ?? 0;
    const rows = await c.env.DB.prepare(
      `SELECT * FROM campaigns WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, perPage, (page - 1) * perPage).all<CampaignRow>();
    const campaigns = await Promise.all((rows.results ?? []).map(r => campaignWithSteps(c.env.DB, r)));
    return c.json({ campaigns, total, page, per_page: perPage });
  });

  app.get('/:id', async (c) => {
    const row = await c.env.DB.prepare(
      `SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?`,
    ).bind(c.req.param('id'), c.get('tenant_id')).first<CampaignRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(await campaignWithSteps(c.env.DB, row));
  });

  app.post('/', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json<{
      name: string; description?: string; channel: 'email'|'whatsapp'|'voice';
      audience_filter?: Record<string, unknown>;
      steps: Array<{ step_index: number; channel: string; template_id: string;
                     credential_id: string; delay_hours: number }>;
    }>();
    if (!body.name) return c.json({ error: 'name_required' }, 400);
    if (!Array.isArray(body.steps) || body.steps.length === 0)
      return c.json({ error: 'at_least_one_step_required' }, 400);

    const tenantId = c.get('tenant_id');
    const id = uuidv4(); const now = nowISO();
    await c.env.DB.prepare(
      `INSERT INTO campaigns
         (id, tenant_id, name, description, channel, status, audience_filter, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).bind(id, tenantId, body.name, body.description ?? null, body.channel,
           body.audience_filter ? JSON.stringify(body.audience_filter) : null, now, now).run();

    for (const s of body.steps) {
      await c.env.DB.prepare(
        `INSERT INTO campaign_steps
           (id, campaign_id, step_index, channel, template_id, credential_id, delay_hours, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(uuidv4(), id, s.step_index, s.channel, s.template_id, s.credential_id, s.delay_hours, now).run();
    }

    const row = await c.env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?`).bind(id).first<CampaignRow>();
    return c.json(await campaignWithSteps(c.env.DB, row!), 201);
  });

  app.put('/:id', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const id = c.req.param('id'); const tenantId = c.get('tenant_id');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const sets: string[] = ['updated_at = ?']; const binds: unknown[] = [nowISO()];
    if (typeof body.name === 'string')        { sets.push('name = ?'); binds.push(body.name); }
    if (typeof body.description === 'string') { sets.push('description = ?'); binds.push(body.description); }
    if (typeof body.channel === 'string')     { sets.push('channel = ?'); binds.push(body.channel); }
    if (body.audience_filter)                 { sets.push('audience_filter = ?'); binds.push(JSON.stringify(body.audience_filter)); }
    binds.push(id, tenantId);
    const res = await c.env.DB.prepare(
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
    ).bind(...binds).run();
    if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
    const row = await c.env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?`).bind(id).first<CampaignRow>();
    return c.json(await campaignWithSteps(c.env.DB, row!));
  });

  app.delete('/:id', async (c) => {
    if (c.get('user_role') !== 'admin' && c.get('user_role') !== 'operator')
      return c.json({ error: 'forbidden' }, 403);
    const res = await c.env.DB.prepare(
      `DELETE FROM campaigns WHERE id = ? AND tenant_id = ?`,
    ).bind(c.req.param('id'), c.get('tenant_id')).run();
    if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ deleted: true });
  });

  // Launch — flips to active, enrolls audience, and immediately enqueues an
  // agent job for each new enrollment so step 0 dispatches without waiting for
  // the next cron tick (60s race that previously dropped messages when an
  // operator cancelled mid-window).
  // Audience filter v1: { tag?: string }. Empty = all contacts.
  app.post('/:id/launch', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const id = c.req.param('id'); const tenantId = c.get('tenant_id'); const now = nowISO();

    const camp = await c.env.DB.prepare(
      `SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?`,
    ).bind(id, tenantId).first<CampaignRow>();
    if (!camp) return c.json({ error: 'not_found' }, 404);
    if (camp.status === 'active') return c.json({ error: 'already_active' }, 409);

    const filter = camp.audience_filter ? JSON.parse(camp.audience_filter) as { tag?: string } : {};
    let contactIds: string[];
    if (filter.tag) {
      const r = await c.env.DB.prepare(
        `SELECT contact_id FROM contact_tags WHERE tenant_id = ? AND tag = ?`,
      ).bind(tenantId, filter.tag).all<{ contact_id: string }>();
      contactIds = (r.results ?? []).map(x => x.contact_id);
    } else {
      const r = await c.env.DB.prepare(
        `SELECT id FROM contacts WHERE tenant_id = ?`,
      ).bind(tenantId).all<{ id: string }>();
      contactIds = (r.results ?? []).map(x => x.id);
    }

    // Resolve step 0 once — same for every new enrollment in this campaign.
    const step0 = await c.env.DB.prepare(
      `SELECT id, channel, template_id, credential_id, delay_hours
       FROM campaign_steps WHERE campaign_id = ? AND step_index = 0`,
    ).bind(id).first<{
      id: string; channel: string; template_id: string|null;
      credential_id: string|null; delay_hours: number;
    }>();

    const newEnrollments: { enrollment_id: string; contact_id: string }[] = [];
    for (const cid of contactIds) {
      const exists = await c.env.DB.prepare(
        `SELECT id FROM campaign_enrollments WHERE campaign_id = ? AND contact_id = ?`,
      ).bind(id, cid).first<{ id: string }>();
      if (exists) continue;
      const enrollmentId = uuidv4();
      await c.env.DB.prepare(
        `INSERT INTO campaign_enrollments
           (id, tenant_id, campaign_id, contact_id, status, current_step_index,
            next_step_at, enrolled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
      ).bind(enrollmentId, tenantId, id, cid, now, now, now, now).run();
      newEnrollments.push({ enrollment_id: enrollmentId, contact_id: cid });
    }

    await c.env.DB.prepare(
      `UPDATE campaigns SET status='active', launched_at=?, enrolled_count=enrolled_count + ?, updated_at=? WHERE id=?`,
    ).bind(now, newEnrollments.length, now, id).run();

    // ── Immediate dispatch — mirror runCampaignTick's per-enrollment work ──
    // If can-send is denied (daily cap), leave the enrollment for the cron to
    // retry — same behavior as the cron's own `continue` branch.
    let dispatched = 0;
    if (step0) {
      const doStub = c.env.CAMPAIGN_DO.get(c.env.CAMPAIGN_DO.idFromName(`${tenantId}:${id}`));
      for (const e of newEnrollments) {
        try {
          const canSendResp = await doStub.fetch('http://do/can-send', {
            method: 'POST',
            body: JSON.stringify({ channel: step0.channel, tenant_id: tenantId }),
          });
          const { allowed } = await canSendResp.json() as { allowed: boolean };
          if (!allowed) continue;

          const runId = uuidv4();
          await c.env.DB.prepare(
            `INSERT OR IGNORE INTO agent_runs
               (id, tenant_id, contact_id, campaign_id, trigger_type, trigger_payload, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'campaign_step', ?, 'queued', ?, ?)`,
          ).bind(
            runId, tenantId, e.contact_id, id,
            JSON.stringify({
              enrollment_id: e.enrollment_id,
              step_id:       step0.id,
              step_index:    0,
              channel:       step0.channel,
              template_id:   step0.template_id,
              credential_id: step0.credential_id,
            }),
            now, now,
          ).run();

          // Advance enrollment: if step 1 exists, bump current_step_index;
          // otherwise mark the enrollment complete.
          const nextStep = await c.env.DB.prepare(
            `SELECT id FROM campaign_steps WHERE campaign_id=? AND step_index=1`,
          ).bind(id).first<{ id: string }>();
          if (nextStep) {
            await c.env.DB.prepare(
              `UPDATE campaign_enrollments
                 SET current_step_index = 1,
                     next_step_at = datetime('now', '+' || ? || ' hours'),
                     updated_at = ?
               WHERE id = ?`,
            ).bind(step0.delay_hours, now, e.enrollment_id).run();
          } else {
            await c.env.DB.prepare(
              `UPDATE campaign_enrollments
                 SET status='completed', completed_at=?, updated_at=?
               WHERE id = ?`,
            ).bind(now, now, e.enrollment_id).run();
          }

          await c.env.Q_AGENT.send({
            id:              uuidv4(),
            tenant_id:       tenantId,
            attempt:         1,
            enqueued_at:     now,
            type:            'agent_job',
            run_id:          runId,
            contact_id:      e.contact_id,
            campaign_id:     id,
            trigger_type:    'campaign_step',
            trigger_payload: {
              enrollment_id: e.enrollment_id,
              step_id:       step0.id,
              step_index:    0,
              channel:       step0.channel,
              template_id:   step0.template_id,
              credential_id: step0.credential_id,
            },
          });
          dispatched++;
        } catch (err) {
          // Don't fail the launch if one enrollment can't be dispatched —
          // the cron will retry it next tick.
          console.error('[campaigns/launch] immediate dispatch failed', e.enrollment_id, err);
        }
      }
    }

    return c.json({ launched: true, enrolled: newEnrollments.length, dispatched });
  });

  app.post('/:id/pause', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    await c.env.DB.prepare(
      `UPDATE campaigns SET status='paused', updated_at=? WHERE id=? AND tenant_id=?`,
    ).bind(nowISO(), c.req.param('id'), c.get('tenant_id')).run();
    const row = await c.env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?`).bind(c.req.param('id')).first<CampaignRow>();
    return c.json(await campaignWithSteps(c.env.DB, row!));
  });

  app.post('/:id/resume', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    await c.env.DB.prepare(
      `UPDATE campaigns SET status='active', updated_at=? WHERE id=? AND tenant_id=?`,
    ).bind(nowISO(), c.req.param('id'), c.get('tenant_id')).run();
    const row = await c.env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?`).bind(c.req.param('id')).first<CampaignRow>();
    return c.json(await campaignWithSteps(c.env.DB, row!));
  });

  app.post('/:id/cancel', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const now = nowISO();
    await c.env.DB.prepare(
      `UPDATE campaigns SET status='cancelled', completed_at=?, updated_at=? WHERE id=? AND tenant_id=?`,
    ).bind(now, now, c.req.param('id'), c.get('tenant_id')).run();
    await c.env.DB.prepare(
      `UPDATE campaign_enrollments SET status='stopped', stopped_at=?, updated_at=? WHERE campaign_id=? AND status='active'`,
    ).bind(now, now, c.req.param('id')).run();
    const row = await c.env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?`).bind(c.req.param('id')).first<CampaignRow>();
    return c.json(await campaignWithSteps(c.env.DB, row!));
  });

  return app;
}

// ─── Templates ───────────────────────────────────────────────────────────────

export function createTemplatesRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/', async (c) => {
    const tenantId = c.get('tenant_id');
    const q = c.req.query();
    const where: string[] = ['tenant_id = ?']; const binds: unknown[] = [tenantId];
    if (q.channel) { where.push('channel = ?'); binds.push(q.channel); }
    const r = await c.env.DB.prepare(
      `SELECT id, name, channel, subject, body_html, body_text, template_name, template_language, created_at
       FROM templates WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
    ).bind(...binds).all<{
      id: string; name: string; channel: string;
      subject?: string|null; body_html?: string|null; body_text?: string|null;
      template_name?: string|null; template_language?: string|null; created_at: string;
    }>();
    return c.json({ templates: (r.results ?? []).map(t => ({
      id: t.id, name: t.name, channel: t.channel,
      subject: t.subject ?? undefined, body_html: t.body_html ?? undefined, body_text: t.body_text ?? undefined,
      template_name: t.template_name ?? undefined, created_at: t.created_at,
    })) });
  });

  app.post('/', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json<{
      name: string; channel: 'email'|'whatsapp'|'voice';
      subject?: string; body_html?: string; body_text?: string;
      template_name?: string; template_language?: string;
    }>();
    if (!body.name || !body.channel) return c.json({ error: 'name_and_channel_required' }, 400);
    const id = uuidv4(); const now = nowISO();
    await c.env.DB.prepare(
      `INSERT INTO templates
         (id, tenant_id, name, channel, subject, body_html, body_text,
          content_html, content_text, template_name, template_language, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, c.get('tenant_id'), body.name, body.channel,
      body.subject ?? null, body.body_html ?? null, body.body_text ?? null,
      body.body_html ?? null, body.body_text ?? null,
      body.template_name ?? null, body.template_language ?? null, now,
    ).run();
    const row = await c.env.DB.prepare(
      `SELECT id, name, channel, subject, body_html, body_text, template_name, created_at FROM templates WHERE id=?`,
    ).bind(id).first<{
      id: string; name: string; channel: string;
      subject?: string|null; body_html?: string|null; body_text?: string|null;
      template_name?: string|null; created_at: string;
    }>();
    return c.json({
      id: row!.id, name: row!.name, channel: row!.channel,
      subject: row!.subject ?? undefined, body_html: row!.body_html ?? undefined, body_text: row!.body_text ?? undefined,
      template_name: row!.template_name ?? undefined, created_at: row!.created_at,
    }, 201);
  });

  return app;
}
