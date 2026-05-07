// workers/icrv-api/src/routes/api-keys.ts
// Phase 5 — tenant-scoped API key generation + webhook subscription CRUD.
// Mounted at /v1/settings/api_webhooks/* alongside the JSON-blob settings route.

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import { uuidv4, nowISO } from '@icrv/shared/crypto';

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createApiKeysRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.post('/generate-key', async (c) => {
    if (c.get('user_role') !== 'admin') return c.json({ error: 'forbidden' }, 403);
    const tenantId = c.get('tenant_id');
    // Revoke existing keys.
    await c.env.DB.prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL`,
    ).bind(nowISO(), tenantId).run();
    // Generate sk_<48-char-base32>
    const random = crypto.getRandomValues(new Uint8Array(30));
    const b64 = btoa(String.fromCharCode(...random)).replace(/[^A-Za-z0-9]/g, '');
    const key = `sk_${b64.slice(0, 48)}`;
    const last4 = key.slice(-4);
    const hash = await sha256Hex(key);
    await c.env.DB.prepare(
      `INSERT INTO api_keys (id, tenant_id, key_hash, last4, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(uuidv4(), tenantId, hash, last4, nowISO()).run();
    // Mirror last4 + created_at into tenant_settings for fast UI render.
    await c.env.DB.prepare(
      `INSERT INTO tenant_settings (tenant_id, api_webhooks_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         api_webhooks_json = json_patch(COALESCE(tenant_settings.api_webhooks_json, '{}'), ?),
         updated_at = excluded.updated_at`,
    ).bind(
      tenantId,
      JSON.stringify({ api_key_last4: last4, api_key_created_at: nowISO() }),
      nowISO(),
      JSON.stringify({ api_key_last4: last4, api_key_created_at: nowISO() }),
    ).run().catch(async () => {
      // json_patch may not be available; fall back to read-modify-write.
      const cur = await c.env.DB.prepare(
        `SELECT api_webhooks_json FROM tenant_settings WHERE tenant_id=?`,
      ).bind(tenantId).first<{ api_webhooks_json: string | null }>();
      const merged: Record<string, unknown> = cur?.api_webhooks_json ? safeJson(cur.api_webhooks_json) : {};
      merged.api_key_last4 = last4;
      merged.api_key_created_at = nowISO();
      await c.env.DB.prepare(
        `UPDATE tenant_settings SET api_webhooks_json = ?, updated_at = ? WHERE tenant_id = ?`,
      ).bind(JSON.stringify(merged), nowISO(), tenantId).run();
    });
    return c.json({ api_key: key, last4 });
  });

  return app;
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
