// workers/icrv-agent/src/control-panel.ts
// Control Panel Backend — Hono routes mounted at /v1/agent-controls
//
// Exposes the full agent_controls CRUD so operators can:
//   - Set kill switches at any scope (global/tenant/campaign/contact)
//   - Define quiet hours, channel allow-lists, daily caps
//   - Review and approve/reject/edit pending agent_runs
//   - Revoke already-dispatched agent_actions before they are sent
//
// All mutations write audit_logs rows.
// All routes require a valid tenant JWT (validated by parent router before mounting).

import { Hono, type Context } from 'hono';
import type { BaseEnv } from '@icrv/shared/types';
import { uuidv4, nowISO } from '@icrv/shared/crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Env for this worker (control panel only needs BaseEnv — identity comes
// from request headers injected by the parent icrv-api JWT middleware)
// ─────────────────────────────────────────────────────────────────────────────

// Hono context variable types (populated by authMiddleware below)
type CtxVars = {
  tenant_id: string;
  user_id:   string;
  user_role: string; // 'admin' | 'operator' | 'viewer'
};

type HonoCtx = { Bindings: BaseEnv; Variables: CtxVars };

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware — extracts identity from headers set by the icrv-api proxy.
//
// icrv-api validates the JWT and then forwards to icrv-agent via service
// binding, adding these three headers:
//   X-Tenant-ID   : tenant UUID from JWT claim
//   X-User-ID     : user UUID from JWT sub
//   X-User-Role   : 'admin' | 'operator' | 'viewer' from JWT claim
//
// If any header is missing the request is rejected 401.
// ─────────────────────────────────────────────────────────────────────────────

async function authMiddleware(
  c:    Context<HonoCtx>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const tenantId = c.req.header('X-Tenant-ID');
  const userId   = c.req.header('X-User-ID');
  const userRole = c.req.header('X-User-Role');

  if (!tenantId || !userId || !userRole) {
    return c.json({ error: 'missing_identity_headers' }, 401);
  }

  const validRoles = ['admin', 'operator', 'viewer'];
  if (!validRoles.includes(userRole)) {
    return c.json({ error: `invalid_user_role:${userRole}` }, 401);
  }

  c.set('tenant_id', tenantId);
  c.set('user_id',   userId);
  c.set('user_role', userRole);
  await next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

type ControlScope = 'global' | 'tenant' | 'campaign' | 'contact';
const VALID_SCOPES: ControlScope[] = ['global', 'tenant', 'campaign', 'contact'];

interface AgentControlsPayload {
  kill_switch?:             boolean;
  allowed_channels?:        string[];
  quiet_hours?:             { start: string; end: string; timezone: string } | null;
  max_per_day?:             number;
  approval_threshold?:      number;
  require_call_approval?:   boolean;
  max_unanswered_sequence?: number;
}

function validateControlsPayload(body: unknown): { ok: true; data: AgentControlsPayload } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body_must_be_object' };
  const b = body as Record<string, unknown>;

  if (b.kill_switch !== undefined && typeof b.kill_switch !== 'boolean')
    return { ok: false, error: 'kill_switch_must_be_boolean' };
  if (b.allowed_channels !== undefined && !Array.isArray(b.allowed_channels))
    return { ok: false, error: 'allowed_channels_must_be_array' };
  if (b.max_per_day !== undefined && (typeof b.max_per_day !== 'number' || b.max_per_day < 0))
    return { ok: false, error: 'max_per_day_must_be_non_negative_number' };
  if (b.approval_threshold !== undefined && (typeof b.approval_threshold !== 'number' || b.approval_threshold < 0 || b.approval_threshold > 1))
    return { ok: false, error: 'approval_threshold_must_be_0_to_1' };
  if (b.require_call_approval !== undefined && typeof b.require_call_approval !== 'boolean')
    return { ok: false, error: 'require_call_approval_must_be_boolean' };
  if (b.max_unanswered_sequence !== undefined && (typeof b.max_unanswered_sequence !== 'number' || b.max_unanswered_sequence < 0))
    return { ok: false, error: 'max_unanswered_sequence_must_be_non_negative_number' };

  if (b.quiet_hours !== null && b.quiet_hours !== undefined) {
    const qh = b.quiet_hours as Record<string, unknown>;
    if (typeof qh.start !== 'string' || typeof qh.end !== 'string' || typeof qh.timezone !== 'string')
      return { ok: false, error: 'quiet_hours_must_have_start_end_timezone_strings' };
    const timeRe = /^\d{2}:\d{2}$/;
    if (!timeRe.test(qh.start) || !timeRe.test(qh.end))
      return { ok: false, error: 'quiet_hours_start_end_must_be_HH:MM' };
  }

  return { ok: true, data: b as AgentControlsPayload };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log writer
// ─────────────────────────────────────────────────────────────────────────────

async function writeAudit(
  env:      BaseEnv,
  tenantId: string,
  userId:   string,
  action:   string,
  resource: string,
  data:     unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs
       (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, data, created_at)
     VALUES (?, ?, 'operator', ?, ?, 'agent_controls', ?, ?, ?)`,
  ).bind(
    uuidv4(), tenantId, userId,
    action, resource,
    JSON.stringify(data),
    nowISO(),
  ).run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export function createControlPanelRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  // All routes require valid identity headers
  app.use('/*', authMiddleware);

  // ──────────────────────────────────────────────────────────────────────────
  // AGENT CONTROLS — CRUD
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /v1/agent-controls
   * List all controls for this tenant (all scopes)
   */
  app.get('/', async (c) => {
    const tenantId = c.get('tenant_id');

    const result = await c.env.DB.prepare(
      `SELECT id, scope, campaign_id, contact_id, controls_json, created_at, updated_at
       FROM agent_controls WHERE tenant_id = ?
       ORDER BY scope, created_at DESC`,
    ).bind(tenantId).all<{
      id: string; scope: string; campaign_id?: string; contact_id?: string;
      controls_json: string; created_at: string; updated_at: string;
    }>();

    return c.json({
      controls: (result.results ?? []).map(r => ({
        id:           r.id,
        scope:        r.scope,
        campaign_id:  r.campaign_id,
        contact_id:   r.contact_id,
        settings:     JSON.parse(r.controls_json) as AgentControlsPayload,
        created_at:   r.created_at,
        updated_at:   r.updated_at,
      })),
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // KILL SWITCH
  // Registered before /:scope handlers so the static path wins route matching.
  // (When `app.delete('/:scope')` is registered first, Hono captures
  // /kill-switch as scope='kill-switch', deletes zero rows, and returns 200 —
  // a silent failure that surfaces as "UI says enabled, D1 still has
  // kill_switch=true". Bug discovered during the 2026-05-06 make-it-real run.)
  // ──────────────────────────────────────────────────────────────────────────

  app.post('/kill-switch', async (c) => {
    const userRole = c.get('user_role');
    if (!['admin', 'operator'].includes(userRole)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const body = await c.req.json<{
      scope:        ControlScope;
      campaign_id?: string;
      contact_id?:  string;
      reason?:      string;
    }>();

    if (!VALID_SCOPES.includes(body.scope)) {
      return c.json({ error: 'invalid_scope' }, 400);
    }

    const tenantId  = c.get('tenant_id');
    const userId    = c.get('user_id');
    const now       = nowISO();
    const controlId = uuidv4();

    const killPayload = JSON.stringify({ kill_switch: true });

    await c.env.DB.prepare(
      `INSERT INTO agent_controls
         (id, tenant_id, scope, campaign_id, contact_id, controls_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, scope, COALESCE(campaign_id,''), COALESCE(contact_id,''))
       DO UPDATE SET controls_json=json_patch(controls_json, '{"kill_switch":true}'), updated_at=excluded.updated_at`,
    ).bind(
      controlId, tenantId, body.scope,
      body.campaign_id ?? null, body.contact_id ?? null,
      killPayload, now, now,
    ).run();

    await c.env.KV_CONFIG.put(
      `kill_switch:${tenantId}:${body.scope}:${body.campaign_id ?? ''}:${body.contact_id ?? ''}`,
      '1',
      { expirationTtl: 7 * 86400 },
    );

    await writeAudit(c.env, tenantId, userId, 'kill_switch_activated',
      `${body.scope}:${body.campaign_id ?? ''}:${body.contact_id ?? ''}`,
      { reason: body.reason, user_id: userId });

    return c.json({ ok: true, kill_switch: true, scope: body.scope });
  });

  app.delete('/kill-switch', async (c) => {
    const userRole = c.get('user_role');
    if (!['admin', 'operator'].includes(userRole)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const { scope, campaign_id, contact_id } = c.req.query() as {
      scope: ControlScope; campaign_id?: string; contact_id?: string;
    };

    if (!VALID_SCOPES.includes(scope)) return c.json({ error: 'invalid_scope' }, 400);

    const tenantId = c.get('tenant_id');
    const userId   = c.get('user_id');
    const now      = nowISO();

    await c.env.DB.prepare(
      `UPDATE agent_controls
       SET controls_json=json_patch(controls_json, '{"kill_switch":false}'), updated_at=?
       WHERE tenant_id=? AND scope=?
         AND COALESCE(campaign_id,'')=?
         AND COALESCE(contact_id,'')=?`,
    ).bind(now, tenantId, scope, campaign_id ?? '', contact_id ?? '').run();

    await c.env.KV_CONFIG.delete(
      `kill_switch:${tenantId}:${scope}:${campaign_id ?? ''}:${contact_id ?? ''}`,
    );

    await writeAudit(c.env, tenantId, userId, 'kill_switch_deactivated',
      `${scope}:${campaign_id ?? ''}:${contact_id ?? ''}`, { user_id: userId });

    return c.json({ ok: true, kill_switch: false, scope });
  });

  /**
   * PUT /v1/agent-controls/:scope
   */
  app.put('/:scope', async (c) => {
    if (c.get('user_role') === 'viewer') {
      return c.json({ error: 'forbidden' }, 403);
    }

    const scope = c.req.param('scope') as ControlScope;
    if (!VALID_SCOPES.includes(scope)) {
      return c.json({ error: `invalid_scope: must be one of ${VALID_SCOPES.join(', ')}` }, 400);
    }

    const rawBody = await c.req.json<AgentControlsPayload & { campaign_id?: string; contact_id?: string }>();
    const { campaign_id, contact_id, ...controlsPayload } = rawBody;

    const validation = validateControlsPayload(controlsPayload);
    if (!validation.ok) return c.json({ error: validation.error }, 400);

    if (scope === 'campaign' && !campaign_id) {
      return c.json({ error: 'campaign_id_required_for_campaign_scope' }, 400);
    }
    if (scope === 'contact' && !contact_id) {
      return c.json({ error: 'contact_id_required_for_contact_scope' }, 400);
    }

    const tenantId = c.get('tenant_id');
    const now      = nowISO();
    const controlId = uuidv4();

    await c.env.DB.prepare(
      `INSERT INTO agent_controls
         (id, tenant_id, scope, campaign_id, contact_id, controls_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, scope, COALESCE(campaign_id,''), COALESCE(contact_id,''))
       DO UPDATE SET controls_json=excluded.controls_json, updated_at=excluded.updated_at`,
    ).bind(
      controlId, tenantId, scope,
      campaign_id ?? null, contact_id ?? null,
      JSON.stringify(validation.data),
      now, now,
    ).run();

    await writeAudit(c.env, tenantId, c.get('user_id'), `controls_updated:${scope}`, controlId, validation.data);
    await c.env.KV_CONFIG.delete(`controls:${tenantId}:${scope}:${campaign_id ?? ''}:${contact_id ?? ''}`);

    return c.json({ ok: true, scope, settings: validation.data });
  });

  /**
   * DELETE /v1/agent-controls/:scope
   */
  app.delete('/:scope', async (c) => {
    if (c.get('user_role') === 'viewer') {
      return c.json({ error: 'forbidden' }, 403);
    }

    const scope    = c.req.param('scope') as ControlScope;
    if (!VALID_SCOPES.includes(scope)) {
      return c.json({ error: `invalid_scope: must be one of ${VALID_SCOPES.join(', ')}` }, 400);
    }
    const tenantId = c.get('tenant_id');
    const { campaign_id, contact_id } = c.req.query() as { campaign_id?: string; contact_id?: string };

    await c.env.DB.prepare(
      `DELETE FROM agent_controls
       WHERE tenant_id=? AND scope=?
         AND COALESCE(campaign_id,'')=?
         AND COALESCE(contact_id,'')=?`,
    ).bind(tenantId, scope, campaign_id ?? '', contact_id ?? '').run();

    await writeAudit(c.env, tenantId, c.get('user_id'), `controls_deleted:${scope}`,
      `${scope}:${campaign_id ?? ''}:${contact_id ?? ''}`, {});
    return c.json({ ok: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PENDING AGENT RUNS
  // ──────────────────────────────────────────────────────────────────────────

  app.get('/runs/pending', async (c) => {
    const tenantId = c.get('tenant_id');

    const result = await c.env.DB.prepare(
      `SELECT ar.id, ar.contact_id, ar.campaign_id, ar.trigger_type,
              ar.decision_json, ar.llm_output_ref, ar.status,
              ar.created_at, ar.updated_at,
              c.name AS contact_name, c.email AS contact_email
       FROM agent_runs ar
       JOIN contacts c ON c.id = ar.contact_id
       WHERE ar.tenant_id = ? AND ar.status IN ('pending','pending_human')
       ORDER BY ar.created_at ASC
       LIMIT 100`,
    ).bind(tenantId).all<{
      id: string; contact_id: string; campaign_id?: string; trigger_type: string;
      decision_json?: string; llm_output_ref?: string; status: string;
      created_at: string; updated_at: string;
      contact_name: string; contact_email?: string;
    }>();

    const runs = (result.results ?? []).map(r => ({
      id:           r.id,
      contact:      { id: r.contact_id, name: r.contact_name, email: r.contact_email },
      campaign_id:  r.campaign_id,
      trigger_type: r.trigger_type,
      decision:     r.decision_json ? JSON.parse(r.decision_json) : null,
      status:       r.status,
      created_at:   r.created_at,
      updated_at:   r.updated_at,
    }));

    return c.json({ runs, count: runs.length });
  });

  app.post('/runs/:runId/approve', async (c) => {
    if (c.get('user_role') === 'viewer') {
      return c.json({ error: 'forbidden' }, 403);
    }

    const runId    = c.req.param('runId');
    const tenantId = c.get('tenant_id');
    const userId   = c.get('user_id');
    const now      = nowISO();

    const run = await c.env.DB.prepare(
      `SELECT id, status FROM agent_runs WHERE id = ? AND tenant_id = ?`,
    ).bind(runId, tenantId).first<{ id: string; status: string }>();

    if (!run) return c.json({ error: 'run_not_found' }, 404);
    if (!['pending', 'pending_human'].includes(run.status)) {
      return c.json({ error: `run_not_in_pending_state:${run.status}` }, 409);
    }

    await c.env.DB.prepare(
      `UPDATE agent_runs
       SET status='approved', approved_by=?, approved_at=?, updated_at=?
       WHERE id=?`,
    ).bind(userId, now, now, runId).run();

    await c.env.Q_AGENT.send({
      id:           uuidv4(),
      type:         'agent_dispatch',
      tenant_id:    tenantId,
      attempt:      1,
      enqueued_at:  now,
      run_id:       runId,
    });

    await writeAudit(c.env, tenantId, userId, 'run_approved', runId, { approved_by: userId });
    return c.json({ ok: true, run_id: runId, status: 'approved' });
  });

  app.post('/runs/:runId/reject', async (c) => {
    if (c.get('user_role') === 'viewer') {
      return c.json({ error: 'forbidden' }, 403);
    }

    const runId    = c.req.param('runId');
    const tenantId = c.get('tenant_id');
    const userId   = c.get('user_id');
    const now      = nowISO();
    const body     = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));

    const run = await c.env.DB.prepare(
      `SELECT id, status FROM agent_runs WHERE id = ? AND tenant_id = ?`,
    ).bind(runId, tenantId).first<{ id: string; status: string }>();

    if (!run) return c.json({ error: 'run_not_found' }, 404);

    await c.env.DB.prepare(
      `UPDATE agent_runs
       SET status='rejected', rejection_reason=?, rejected_by=?, rejected_at=?, updated_at=?
       WHERE id=?`,
    ).bind(body.reason ?? 'operator_rejected', userId, now, now, runId).run();

    await writeAudit(c.env, tenantId, userId, 'run_rejected', runId,
      { reason: body.reason, rejected_by: userId });
    return c.json({ ok: true, run_id: runId, status: 'rejected' });
  });

  app.patch('/runs/:runId/edit', async (c) => {
    if (c.get('user_role') === 'viewer') {
      return c.json({ error: 'forbidden' }, 403);
    }

    const runId    = c.req.param('runId');
    const tenantId = c.get('tenant_id');
    const userId   = c.get('user_id');
    const now      = nowISO();
    const body     = await c.req.json<{ decision: Record<string, unknown> }>();

    if (!body.decision || typeof body.decision !== 'object') {
      return c.json({ error: 'decision_required' }, 400);
    }

    const run = await c.env.DB.prepare(
      `SELECT id, status FROM agent_runs WHERE id = ? AND tenant_id = ?`,
    ).bind(runId, tenantId).first<{ id: string; status: string }>();

    if (!run) return c.json({ error: 'run_not_found' }, 404);
    if (!['pending', 'pending_human'].includes(run.status)) {
      return c.json({ error: `run_not_editable:${run.status}` }, 409);
    }

    await c.env.DB.prepare(
      `UPDATE agent_runs
       SET decision_json=?, edited_by=?, edited_at=?, updated_at=?
       WHERE id=?`,
    ).bind(JSON.stringify(body.decision), userId, now, now, runId).run();

    await writeAudit(c.env, tenantId, userId, 'run_edited', runId,
      { edited_by: userId, decision: body.decision });
    return c.json({ ok: true, run_id: runId });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AGENT ACTIONS — Revoke
  // ──────────────────────────────────────────────────────────────────────────

  app.post('/actions/:actionId/revoke', async (c) => {
    if (c.get('user_role') === 'viewer') {
      return c.json({ error: 'forbidden' }, 403);
    }

    const actionId = c.req.param('actionId');
    const tenantId = c.get('tenant_id');
    const userId   = c.get('user_id');
    const now      = nowISO();
    const body     = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));

    const action = await c.env.DB.prepare(
      `SELECT id, status, action_type FROM agent_actions WHERE id = ? AND tenant_id = ?`,
    ).bind(actionId, tenantId).first<{ id: string; status: string; action_type: string }>();

    if (!action) return c.json({ error: 'action_not_found' }, 404);
    if (action.status === 'sent') {
      return c.json({ error: 'action_already_sent_cannot_revoke' }, 409);
    }
    if (action.status === 'revoked') {
      return c.json({ error: 'action_already_revoked' }, 409);
    }

    await c.env.DB.prepare(
      `UPDATE agent_actions
       SET status='revoked', revocation_reason=?, revoked_by=?, updated_at=?
       WHERE id=?`,
    ).bind(body.reason ?? 'operator_revoked', userId, now, actionId).run();

    await writeAudit(c.env, tenantId, userId, 'action_revoked', actionId, {
      reason:      body.reason,
      revoked_by:  userId,
      action_type: action.action_type,
    });
    return c.json({ ok: true, action_id: actionId, status: 'revoked' });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AGENT RUN HISTORY
  // ──────────────────────────────────────────────────────────────────────────

  app.get('/runs', async (c) => {
    const tenantId = c.get('tenant_id');
    const {
      contact_id, campaign_id, status,
      limit = '50', offset = '0',
    } = c.req.query() as Record<string, string>;

    const limitNum  = Math.min(parseInt(limit, 10) || 50, 200);
    const offsetNum = parseInt(offset, 10) || 0;

    const conditions: string[] = ['ar.tenant_id = ?'];
    const bindings:   unknown[] = [tenantId];

    if (contact_id)  { conditions.push('ar.contact_id = ?');  bindings.push(contact_id); }
    if (campaign_id) { conditions.push('ar.campaign_id = ?'); bindings.push(campaign_id); }
    if (status)      { conditions.push('ar.status = ?');      bindings.push(status); }

    const where = conditions.join(' AND ');

    const result = await c.env.DB.prepare(
      `SELECT ar.id, ar.contact_id, ar.campaign_id, ar.trigger_type, ar.status,
              ar.decision_json, ar.cost_usd, ar.duration_ms,
              ar.created_at, ar.updated_at,
              c.name AS contact_name
       FROM agent_runs ar
       JOIN contacts c ON c.id = ar.contact_id
       WHERE ${where}
       ORDER BY ar.created_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(...bindings, limitNum, offsetNum).all<{
      id: string; contact_id: string; campaign_id?: string; trigger_type: string;
      status: string; decision_json?: string; cost_usd?: number; duration_ms?: number;
      created_at: string; updated_at: string; contact_name: string;
    }>();

    return c.json({
      runs: (result.results ?? []).map(r => ({
        id:           r.id,
        contact:      { id: r.contact_id, name: r.contact_name },
        campaign_id:  r.campaign_id,
        trigger_type: r.trigger_type,
        status:       r.status,
        decision:     r.decision_json ? JSON.parse(r.decision_json) : null,
        cost_usd:     r.cost_usd,
        duration_ms:  r.duration_ms,
        created_at:   r.created_at,
        updated_at:   r.updated_at,
      })),
      pagination: { limit: limitNum, offset: offsetNum },
    });
  });

  return app;
}
