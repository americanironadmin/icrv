// workers/icrv-agent/src/index.ts
// AI Decision Engine entry point.
//
//  fetch():  serves the control-panel router at /v1/agent-controls/*
//  queue():  drains icrv-agent-jobs — runs the full pipeline:
//    1. loadRunContext()        →  D1 fan-out into RunContext
//    2. evaluatePolicy()         →  block/defer/escalate/allow
//    3. runLlmPlanner()          →  Anthropic tool_use → AgentPlanOutput
//    4. approval gate            →  honors require_call_approval +
//                                   approval_threshold; sets pending_human
//    5. dispatchAction()         →  enqueues to channel queues
//    6. update agent_runs status →  records cost, duration, decision
//
// Each step is wrapped in try/catch so a single bad message can't poison the
// batch; errors are recorded to agent_runs.failed_reason and DLQ on retry.

import { Hono } from 'hono';
import type { BaseEnv, AgentJobPayload, RetryPayload } from '@icrv/shared/types';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import { isDuplicate, scheduleRetry } from '@icrv/shared/queue-helpers';

import { createControlPanelRouter } from './control-panel';
import { loadRunContext }  from './context-loader';
import { evaluatePolicy }  from './policy-gate';
import { runLlmPlanner }   from './llm-planner';
import { dispatchAction }  from './dispatcher';

// AgentSessionDO must be registered ON this worker
export { AgentSessionDO } from './agent-session-do';

interface AgentEnv extends BaseEnv {
  ANTHROPIC_API_KEY: string;
  AI_MODEL:          string;
}

// ─── HTTP — internal-only, called via service binding from icrv-api ────────

const app = new Hono<{ Bindings: AgentEnv }>();
app.get('/health', (c) => c.json({ ok: true, service: 'icrv-agent', model: c.env.AI_MODEL }));
app.route('/v1/agent-controls', createControlPanelRouter());

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<AgentJobPayload | RetryPayload>, env: AgentEnv): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body;
        const job  = body.type === 'retry' ? (body as RetryPayload).original_payload as AgentJobPayload : body as AgentJobPayload;
        if (await isDuplicate(env, job.id)) { msg.ack(); continue; }
        await runAgentJob(job, env);
        msg.ack();
      } catch (err) {
        const orig = msg.body.type === 'retry' ? (msg.body as RetryPayload).original_payload : msg.body;
        await scheduleRetry(env, 'icrv-agent-jobs', orig as AgentJobPayload, (err as Error).message);
        msg.ack();
      }
    }
  },
} satisfies ExportedHandler<AgentEnv, AgentJobPayload | RetryPayload>;

// ─── Pipeline ──────────────────────────────────────────────────────────────

async function runAgentJob(job: AgentJobPayload, env: AgentEnv): Promise<void> {
  const t0 = Date.now();

  // Resolve / pre-create run row
  let runId = job.run_id;
  if (!runId) {
    runId = uuidv4();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agent_runs
         (id, tenant_id, contact_id, campaign_id, trigger_type, trigger_payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(
      runId, job.tenant_id, job.contact_id ?? '', job.campaign_id ?? null,
      job.trigger_type ?? 'unknown', JSON.stringify(job.trigger_payload ?? {}),
      nowISO(), nowISO(),
    ).run();
  }

  await env.DB.prepare(`UPDATE agent_runs SET status='running', updated_at=? WHERE id=?`)
    .bind(nowISO(), runId).run();

  if (!job.contact_id) {
    await failRun(env, runId, 'missing_contact_id');
    return;
  }

  // Step 1 — load context
  let ctx;
  try {
    ctx = await loadRunContext(job.tenant_id, job.contact_id, job.campaign_id, undefined, env);
    ctx.planInput.trigger_type    = job.trigger_type ?? 'unknown';
    ctx.planInput.trigger_payload = job.trigger_payload ?? {};
  } catch (err) {
    await failRun(env, runId, `context_load_failed:${(err as Error).message}`);
    return;
  }

  // Step 2 — policy gate (BEFORE LLM)
  const intendedChannel = inferIntendedChannel(ctx.planInput);
  const policy = evaluatePolicy({
    tenant_id: job.tenant_id, contact_id: job.contact_id,
    channel: intendedChannel,
    controls: ctx.controls, consent_state: ctx.consent_state,
    is_suppressed: ctx.is_suppressed, sent_today: ctx.sent_today,
    unanswered_sequence: ctx.unanswered_sequence,
    recent_runs: ctx.recent_runs.map(r => ({ trigger_type: r.trigger_type, created_at: r.created_at, status: r.status })),
    now_iso: nowISO(),
  });

  if (policy.outcome === 'block') {
    await env.DB.prepare(
      `UPDATE agent_runs SET status='blocked_by_policy', failed_reason=?, completed_at=?, updated_at=?, duration_ms=? WHERE id=?`,
    ).bind(policy.reason, nowISO(), nowISO(), Date.now() - t0, runId).run();
    return;
  }
  if (policy.outcome === 'defer') {
    await env.DB.prepare(
      `UPDATE agent_runs SET status='deferred', failed_reason=?, next_run_at=?, updated_at=?, duration_ms=? WHERE id=?`,
    ).bind(policy.reason, policy.next_run_at ?? null, nowISO(), Date.now() - t0, runId).run();
    return;
  }
  if (policy.outcome === 'escalate') {
    await env.DB.prepare(
      `UPDATE agent_runs SET status='escalated', failed_reason=?, completed_at=?, updated_at=?, duration_ms=? WHERE id=?`,
    ).bind(policy.reason, nowISO(), nowISO(), Date.now() - t0, runId).run();
    return;
  }

  // Step 3 — LLM
  let plannerResult;
  try {
    plannerResult = await runLlmPlanner(ctx.planInput, env.ANTHROPIC_API_KEY, env.AI_MODEL);
  } catch (err) {
    await failRun(env, runId, `llm_failed:${(err as Error).message}`);
    return;
  }

  // Persist raw IO for audit
  const inRef  = `agent/runs/${runId}/input.json`;
  const outRef = `agent/runs/${runId}/output.json`;
  await env.R2_EVIDENCE.put(inRef,  plannerResult.raw_input);
  await env.R2_EVIDENCE.put(outRef, plannerResult.raw_output);

  await env.DB.prepare(
    `UPDATE agent_runs SET decision_json=?, llm_input_ref=?, llm_output_ref=?, cost_usd=?, updated_at=? WHERE id=?`,
  ).bind(JSON.stringify(plannerResult.plan), inRef, outRef, plannerResult.cost_usd, nowISO(), runId).run();

  // Step 4 — approval gate
  const action = plannerResult.plan.actions[0];
  const requiresApproval =
    plannerResult.plan.risk_level >= ctx.controls.approval_threshold ||
    (action.type === 'place_call' && ctx.controls.require_call_approval);

  if (requiresApproval) {
    await env.DB.prepare(
      `UPDATE agent_runs SET status='pending_human', updated_at=?, duration_ms=? WHERE id=?`,
    ).bind(nowISO(), Date.now() - t0, runId).run();
    return;
  }

  // Step 5 — dispatch
  try {
    await dispatchAction(action, {
      tenant_id: job.tenant_id, contact_id: job.contact_id,
      campaign_id: job.campaign_id, run_id: runId, action_index: 0,
      email:    ctx.dispatchCtx.email,
      whatsapp: ctx.dispatchCtx.whatsapp,
      voice:    ctx.dispatchCtx.voice,
    }, env);
  } catch (err) {
    await failRun(env, runId, `dispatch_failed:${(err as Error).message}`);
    return;
  }

  // Step 6 — push session event for the AgentSessionDO
  const sessStub = env.AGENT_SESSION_DO.get(env.AGENT_SESSION_DO.idFromName(`${job.tenant_id}:${job.contact_id}`));
  await sessStub.fetch('http://do/event', {
    method: 'POST',
    body: JSON.stringify({
      tenant_id: job.tenant_id, contact_id: job.contact_id,
      event: {
        event_type: 'agent_decision', summary: `${action.type} (${plannerResult.plan.risk_level})`,
        occurred_at: nowISO(),
      },
    }),
    headers: { 'Content-Type': 'application/json' },
  }).catch(() => {});

  await env.DB.prepare(
    `UPDATE agent_runs SET status='completed', completed_at=?, updated_at=?, duration_ms=? WHERE id=?`,
  ).bind(nowISO(), nowISO(), Date.now() - t0, runId).run();
}

function inferIntendedChannel(input: { current_step?: { channel?: string }; trigger_type?: string }): string {
  if (input.current_step?.channel) return input.current_step.channel;
  if (input.trigger_type === 'inbound_email') return 'email';
  if (input.trigger_type === 'inbound_whatsapp') return 'whatsapp';
  if (input.trigger_type === 'post_call') return 'voice';
  return 'email'; // safest default
}

async function failRun(env: AgentEnv, runId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE agent_runs SET status='failed', failed_reason=?, completed_at=?, updated_at=? WHERE id=?`,
  ).bind(reason.slice(0, 500), nowISO(), nowISO(), runId).run();
}
