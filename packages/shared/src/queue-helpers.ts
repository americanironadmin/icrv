// packages/shared/src/queue-helpers.ts
// Shared utilities for queue consumers across icrv-consumer, icrv-email,
// icrv-whatsapp, icrv-voice. Rate-limit, idempotency, and retry/DLQ logic.

import type { BaseEnv, QueuePayload, RetryPayload } from './types';
import { rateLimitKey, idempKey, nowISO, uuidv4 } from './crypto';

// ─── Sliding-window rate limit ───────────────────────────────────────────────
// One bucket per (tenant, channel, hour). Caller decides per-channel cap.
// Returns true if the action is permitted; increments the counter on permit.

export async function rateAllow(
  env: BaseEnv,
  tenantId: string,
  channel: string,
  perHourCap: number,
): Promise<{ allowed: boolean; current: number; cap: number }> {
  const key = rateLimitKey(tenantId, channel);
  const cur = parseInt((await env.KV_RATE.get(key)) ?? '0', 10);
  if (cur >= perHourCap) {
    return { allowed: false, current: cur, cap: perHourCap };
  }
  await env.KV_RATE.put(key, String(cur + 1), { expirationTtl: 3600 });
  return { allowed: true, current: cur + 1, cap: perHourCap };
}

// ─── Idempotency ─────────────────────────────────────────────────────────────
// Each queue payload carries a uuid `id`. We dedup by setting a 24h marker.

export async function isDuplicate(env: BaseEnv, payloadId: string): Promise<boolean> {
  const k = idempKey(payloadId);
  const seen = await env.KV_IDEMP.get(k);
  if (seen) return true;
  await env.KV_IDEMP.put(k, '1', { expirationTtl: 86_400 });
  return false;
}

// ─── Retry / DLQ ─────────────────────────────────────────────────────────────
// Exponential backoff: 1m, 5m, 25m, 2h, 10h. After max_attempts → DLQ.

const BACKOFF_MIN = [1, 5, 25, 120, 600] as const;
export const MAX_ATTEMPTS = 5;

export async function scheduleRetry(
  env: BaseEnv,
  originalQueue: string,
  payload: QueuePayload,
  reason: string,
): Promise<void> {
  const attempt = payload.attempt ?? 1;
  if (attempt >= MAX_ATTEMPTS) {
    await deadLetter(env, originalQueue, payload, reason);
    return;
  }
  const delayMin = BACKOFF_MIN[attempt - 1] ?? BACKOFF_MIN[BACKOFF_MIN.length - 1];
  const next: RetryPayload = {
    id: uuidv4(),
    type: 'retry',
    tenant_id: payload.tenant_id,
    attempt: 1,
    enqueued_at: nowISO(),
    original_queue: originalQueue,
    original_payload: { ...payload, attempt: attempt + 1 },
    next_attempt_at: new Date(Date.now() + delayMin * 60_000).toISOString(),
    max_attempts: MAX_ATTEMPTS,
  };
  await env.Q_RETRY.send(next, { delaySeconds: delayMin * 60 });
}

export async function deadLetter(
  env: BaseEnv,
  originalQueue: string,
  payload: QueuePayload,
  reason: string,
): Promise<void> {
  await env.Q_DLQ.send({
    ...payload,
    dlq_reason: reason.slice(0, 500),
    dlq_at: nowISO(),
    type: payload.type ?? originalQueue,
  });

  await env.DB.prepare(
    `INSERT INTO audit_logs
       (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, data, created_at)
     VALUES (?, ?, 'system', NULL, 'dlq', ?, ?, ?, ?)`,
  ).bind(
    uuidv4(),
    payload.tenant_id,
    originalQueue,
    payload.id,
    JSON.stringify({ reason: reason.slice(0, 500), attempt: payload.attempt }),
    nowISO(),
  ).run();
}
