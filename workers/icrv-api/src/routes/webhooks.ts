// workers/icrv-api/src/routes/webhooks.ts
// v2.7 — webhook subscription CRUD + test-event firing.
//
//   GET  /v1/webhooks/subscriptions          — list
//   POST /v1/webhooks/subscriptions          — create (body: {event, url})
//   DELETE /v1/webhooks/subscriptions/:id    — soft delete (is_active=0)
//   POST /v1/webhooks/test/:id               — fire a synthetic event
//   GET  /v1/webhooks/deliveries             — recent delivery audit (last 100)
//
// Each subscription has a unique secret used to HMAC-sign payloads.

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import type { WebhookEvent, WebhookEventPayload } from '@icrv/shared/types';

const ALLOWED_EVENTS: WebhookEvent[] = [
  'email_sent','email_opened','email_clicked','email_bounced','email_unsubscribed',
  'consent_granted','consent_revoked','call_completed','quote_sent','quote_accepted',
];

interface SubRow {
  id: string; tenant_id: string; event: string; url: string; secret: string;
  is_active: number; created_at: string;
}

export function createWebhooksRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/subscriptions', async (c) => {
    const tenantId = c.get('tenant_id');
    const rows = await c.env.DB.prepare(
      `SELECT id, event, url, is_active, created_at FROM webhook_subscriptions
        WHERE tenant_id = ? ORDER BY created_at DESC`,
    ).bind(tenantId).all<{ id: string; event: string; url: string; is_active: number; created_at: string }>();
    return c.json({ subscriptions: rows.results ?? [] });
  });

  app.post('/subscriptions', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json<{ event: WebhookEvent; url: string }>().catch(() => null);
    if (!body || !body.event || !body.url) return c.json({ error: 'event_and_url_required' }, 400);
    if (!ALLOWED_EVENTS.includes(body.event)) return c.json({ error: 'unknown_event' }, 400);
    try { new URL(body.url); } catch { return c.json({ error: 'url_invalid' }, 400); }

    const tenantId = c.get('tenant_id');
    const id = uuidv4();
    const secret = randomSecret();
    await c.env.DB.prepare(
      `INSERT INTO webhook_subscriptions (id, tenant_id, event, url, secret, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).bind(id, tenantId, body.event, body.url, secret, nowISO()).run();
    return c.json({ id, event: body.event, url: body.url, secret, is_active: 1 }, 201);
  });

  app.delete('/subscriptions/:id', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const res = await c.env.DB.prepare(
      `UPDATE webhook_subscriptions SET is_active = 0 WHERE id = ? AND tenant_id = ?`,
    ).bind(id, tenantId).run();
    if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ deactivated: true });
  });

  app.post('/test/:id', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const sub = await c.env.DB.prepare(
      `SELECT * FROM webhook_subscriptions WHERE id = ? AND tenant_id = ? AND is_active = 1`,
    ).bind(id, tenantId).first<SubRow>();
    if (!sub) return c.json({ error: 'not_found_or_inactive' }, 404);
    const deliveryId = await enqueueWebhook(c.env, tenantId, sub.event as WebhookEvent, {
      test:        true,
      tenant_id:   tenantId,
      subscription_id: sub.id,
      sample:      `synthetic ${sub.event} event`,
      timestamp:   nowISO(),
    }, sub);
    return c.json({ enqueued: true, delivery_id: deliveryId });
  });

  app.get('/deliveries', async (c) => {
    const tenantId = c.get('tenant_id');
    const rows = await c.env.DB.prepare(
      `SELECT id, subscription_id, event, status, attempt, last_status_code, last_error,
              created_at, delivered_at, next_retry_at
         FROM webhook_deliveries WHERE tenant_id = ?
        ORDER BY created_at DESC LIMIT 100`,
    ).bind(tenantId).all();
    return c.json({ deliveries: rows.results ?? [] });
  });

  return app;
}

// ─── Producer helper, callable from any route handler ──────────────────────

export async function enqueueWebhooksForEvent(
  env: import('../env').ApiEnv, tenantId: string, event: WebhookEvent, body: Record<string, unknown>,
): Promise<string[]> {
  const subs = await env.DB.prepare(
    `SELECT * FROM webhook_subscriptions WHERE tenant_id = ? AND event = ? AND is_active = 1`,
  ).bind(tenantId, event).all<SubRow>();
  const ids: string[] = [];
  for (const sub of subs.results ?? []) {
    const id = await enqueueWebhook(env, tenantId, event, body, sub);
    ids.push(id);
  }
  return ids;
}

async function enqueueWebhook(
  env: import('../env').ApiEnv, tenantId: string, event: WebhookEvent,
  body: Record<string, unknown>, sub: SubRow,
): Promise<string> {
  const deliveryId = uuidv4();
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries
       (id, tenant_id, subscription_id, event, payload_json, status, attempt, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).bind(deliveryId, tenantId, sub.id, event, JSON.stringify(body), nowISO()).run();
  if (env.Q_WEBHOOK) {
    const payload: WebhookEventPayload = {
      id:              uuidv4(),
      type:            'webhook_event',
      tenant_id:       tenantId,
      attempt:         1,
      enqueued_at:     nowISO(),
      delivery_id:     deliveryId,
      subscription_id: sub.id,
      event,
      url:             sub.url,
      secret:          sub.secret,
      body,
      attempt_no:      0,
    };
    await env.Q_WEBHOOK.send(payload);
  } else {
    await env.DB.prepare(
      `UPDATE webhook_deliveries SET status='failed', last_error='Q_WEBHOOK_not_bound' WHERE id=?`,
    ).bind(deliveryId).run();
  }
  return deliveryId;
}

function randomSecret(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  return [...r].map((b) => b.toString(16).padStart(2, '0')).join('');
}
