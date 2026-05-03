// workers/icrv-api/src/__tests__/role-gate.spec.ts
//
// Verifies the role gates that protect destructive endpoints. We hit Hono apps
// directly via app.fetch() — no real network, no D1, no KV. The gates under
// test (`requireAdmin`, `requireNotViewer`) are the same instances mounted in
// production by routes/misc.ts and index.ts, so passing tests prove the
// production gate behavior.

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireAdmin, requireNotViewer } from '../auth';
import type { HonoCtx } from '../env';

type Role = 'admin' | 'operator' | 'viewer';

function buildAdminApp(role: Role) {
  const app = new Hono<HonoCtx>();
  app.use('*', async (c, next) => {
    c.set('user_role', role);
    c.set('tenant_id', 't_test');
    c.set('user_id', 'u_test');
    c.set('email', `${role}@test`);
    await next();
  });
  // Mirror /v1/admin/* — gate then a handler that would otherwise reach DB.
  app.use('/v1/admin/*', requireAdmin);
  app.delete('/v1/admin/integrations/elevenlabs', (c) => c.json({ ok: true, deleted: true }));
  return app;
}

function buildAgentControlsApp(role: Role) {
  const app = new Hono<HonoCtx>();
  app.use('*', async (c, next) => {
    c.set('user_role', role);
    c.set('tenant_id', 't_test');
    c.set('user_id', 'u_test');
    c.set('email', `${role}@test`);
    await next();
  });
  app.use('/v1/agent-controls/*', requireNotViewer);
  app.post('/v1/agent-controls/kill-switch', (c) => c.json({ ok: true, killed: true }));
  return app;
}

describe('role gates', () => {
  it('viewer cannot POST /v1/agent-controls/kill-switch', async () => {
    const app = buildAgentControlsApp('viewer');
    const res = await app.fetch(new Request('http://test/v1/agent-controls/kill-switch', {
      method: 'POST',
    }));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('forbidden');
  });

  it('operator cannot DELETE /v1/admin/integrations/elevenlabs', async () => {
    const app = buildAdminApp('operator');
    const res = await app.fetch(new Request('http://test/v1/admin/integrations/elevenlabs', {
      method: 'DELETE',
    }));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('admin_required');
  });

  it('admin can do both', async () => {
    const adminApp = buildAdminApp('admin');
    const adminRes = await adminApp.fetch(new Request('http://test/v1/admin/integrations/elevenlabs', {
      method: 'DELETE',
    }));
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toEqual({ ok: true, deleted: true });

    const agentApp = buildAgentControlsApp('admin');
    const agentRes = await agentApp.fetch(new Request('http://test/v1/agent-controls/kill-switch', {
      method: 'POST',
    }));
    expect(agentRes.status).toBe(200);
    expect(await agentRes.json()).toEqual({ ok: true, killed: true });

    // Sanity: operator can also hit the kill-switch (only viewer is blocked).
    const operatorAgentApp = buildAgentControlsApp('operator');
    const operatorAgentRes = await operatorAgentApp.fetch(new Request('http://test/v1/agent-controls/kill-switch', {
      method: 'POST',
    }));
    expect(operatorAgentRes.status).toBe(200);
  });
});
