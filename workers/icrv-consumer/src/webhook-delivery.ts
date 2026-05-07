// workers/icrv-consumer/src/webhook-delivery.ts
// v2.7 — real customer webhook delivery.
//
// Fired off Q_WEBHOOK messages produced by icrv-api routes (or by this worker
// itself during retries). Each delivery:
//   1. POSTs body as JSON to the subscription URL.
//   2. Headers carry X-ICRV-Event, X-ICRV-Delivery-Id, X-ICRV-Timestamp,
//      X-ICRV-Signature: sha256=<hex(HMAC-SHA256(secret, ts + '.' + body))>.
//   3. On 2xx: marks webhook_deliveries.status='delivered', records 200/etc.
//   4. On 4xx (other than 408/429): marks status='failed' (no retry —
//      client error, retrying won't help). 408/429: schedule retry.
//   5. On 5xx / network error / timeout: schedule retry.
//
// Retry schedule: 30s, 2 min, 10 min. After attempt 3 fails, status='dlq'.

import type { BaseEnv, WebhookEventPayload, RetryPayload } from '@icrv/shared/types';
import { uuidv4, nowISO } from '@icrv/shared/crypto';

const RETRY_DELAYS_SEC = [30, 120, 600]; // 30s, 2m, 10m
const MAX_ATTEMPTS = 3; // = RETRY_DELAYS_SEC.length

export async function processWebhookEvent(p: WebhookEventPayload, env: BaseEnv): Promise<void> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyJson = JSON.stringify(p.body);
  const signature = await hmacHex(p.secret, `${ts}.${bodyJson}`);

  await env.DB.prepare(
    `UPDATE webhook_deliveries SET attempt = ?, last_status_code = NULL, last_error = NULL WHERE id = ?`,
  ).bind(p.attempt_no + 1, p.delivery_id).run();

  let status = 0;
  let errMsg: string | null = null;
  let success = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(p.url, {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'User-Agent':           'icrv-webhooks/1.0',
        'X-ICRV-Event':         p.event,
        'X-ICRV-Delivery-Id':   p.delivery_id,
        'X-ICRV-Timestamp':     ts,
        'X-ICRV-Signature':     `sha256=${signature}`,
      },
      body:   bodyJson,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    status = res.status;
    if (status >= 200 && status < 300) success = true;
    if (!success && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      // Permanent client error — give up immediately.
      await markFailed(env, p, status, `HTTP ${status}`);
      return;
    }
    if (!success) errMsg = `HTTP ${status}`;
  } catch (err) {
    errMsg = (err as Error).message ?? 'fetch_failed';
  }

  if (success) {
    await markDelivered(env, p, status);
    return;
  }

  // Retry path.
  const nextAttempt = p.attempt_no + 1;
  if (nextAttempt >= MAX_ATTEMPTS) {
    await markDlq(env, p, status, errMsg ?? 'unknown');
    return;
  }
  const delaySec = RETRY_DELAYS_SEC[nextAttempt];
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET status='pending', last_status_code=?, last_error=?,
       next_retry_at = datetime('now', ?) WHERE id=?`,
  ).bind(status || null, errMsg ?? null, `+${delaySec} seconds`, p.delivery_id).run();

  // Re-enqueue via Q_RETRY so the existing retry router schedules a
  // delayed re-delivery to icrv-webhooks.
  const retry: RetryPayload = {
    id:               uuidv4(),
    type:             'retry',
    tenant_id:        p.tenant_id,
    attempt:          nextAttempt + 1,
    enqueued_at:      nowISO(),
    original_queue:   'icrv-webhooks',
    original_payload: { ...p, attempt_no: nextAttempt } as never,
    next_attempt_at:  new Date(Date.now() + delaySec * 1000).toISOString(),
    max_attempts:     MAX_ATTEMPTS,
  };
  await env.Q_RETRY.send(retry, { delaySeconds: delaySec });
}

async function markDelivered(env: BaseEnv, p: WebhookEventPayload, status: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET status='delivered', last_status_code=?, last_error=NULL,
                                   delivered_at=?, next_retry_at=NULL WHERE id=?`,
  ).bind(status, nowISO(), p.delivery_id).run();
}

async function markFailed(env: BaseEnv, p: WebhookEventPayload, status: number, err: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET status='failed', last_status_code=?, last_error=?,
                                   next_retry_at=NULL WHERE id=?`,
  ).bind(status || null, err, p.delivery_id).run();
}

async function markDlq(env: BaseEnv, p: WebhookEventPayload, status: number, err: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET status='dlq', last_status_code=?, last_error=?,
                                   next_retry_at=NULL WHERE id=?`,
  ).bind(status || null, err, p.delivery_id).run();
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
