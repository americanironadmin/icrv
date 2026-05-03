// packages/shared/src/rate-limit.ts
//
// Sliding-window-ish rate limiter backed by KV. Sufficient for per-IP and
// per-IP+tenant abuse caps; not a precise token bucket. KV writes are
// eventually consistent, so the limit is approximate (a burst across regions
// can briefly exceed `max`); we accept that in exchange for zero-infrastructure.
//
// Bucket key: `rl:<key>:<windowStart>` where windowStart is the unix
// second floored to `windowSec`. The bucket TTLs out at 2*windowSec, which
// avoids needing any cleanup job.

import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitBindings {
  KV_RATE: KVNamespace;
}

export interface RateLimitDecision {
  allowed: boolean;
  count:   number;
  max:     number;
  retryAfter: number;
  resetAt: number;
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ??
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export function cfIp(c: Context): string {
  return clientIp(c.req.raw);
}

// Pure check + counter-bump. Returns the decision so callers can decide how to
// shape the rejection response (status, body, extra headers).
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  max: number,
  windowSec: number,
): Promise<RateLimitDecision> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const bucketKey = `rl:${key}:${windowStart}`;

  const raw = await kv.get(bucketKey);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  const resetAt = windowStart + windowSec;
  const retryAfter = resetAt - now;

  if (count >= max) {
    return { allowed: false, count, max, retryAfter, resetAt };
  }

  await kv.put(bucketKey, String(count + 1), { expirationTtl: windowSec * 2 });
  return { allowed: true, count: count + 1, max, retryAfter, resetAt };
}

export function rateLimitedResponse(decision: RateLimitDecision): Response {
  return new Response(
    JSON.stringify({ error: 'rate_limited', retry_after_seconds: decision.retryAfter }),
    {
      status: 429,
      headers: {
        'Content-Type':           'application/json',
        'Retry-After':            String(decision.retryAfter),
        'X-RateLimit-Limit':      String(decision.max),
        'X-RateLimit-Remaining':  '0',
        'X-RateLimit-Reset':      String(decision.resetAt),
      },
    },
  );
}

export interface RateLimitOpts {
  max: number;
  windowSec: number;
  keyFn: (c: Context) => string;
}

export function rateLimit(opts: RateLimitOpts): MiddlewareHandler {
  return async (c, next) => {
    const env = c.env as RateLimitBindings;
    if (!env?.KV_RATE) {
      // Misconfigured worker — fail open rather than blocking traffic.
      await next();
      return;
    }

    const decision = await checkRateLimit(env.KV_RATE, opts.keyFn(c), opts.max, opts.windowSec);
    if (!decision.allowed) return rateLimitedResponse(decision);

    await next();

    try {
      c.res.headers.set('X-RateLimit-Limit', String(decision.max));
      c.res.headers.set('X-RateLimit-Remaining', String(Math.max(0, decision.max - decision.count)));
      c.res.headers.set('X-RateLimit-Reset', String(decision.resetAt));
    } catch {
      // Some upstream responses (e.g. service-binding fetch) have immutable
      // headers — rate-limit headers are informational, not load-bearing.
    }
  };
}
