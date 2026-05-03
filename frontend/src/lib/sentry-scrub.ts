// frontend/src/lib/sentry-scrub.ts
// Recursive PII / secret scrubber for Sentry's `beforeSend`. Mirrors
// packages/shared/src/sentry-scrub.ts (frontend is not in the npm workspace,
// so the shared module can't be imported directly).

const SECRET_KEY_PATTERN = /^(authorization|cookie|x-cf-access-jwt-assertion|cf-access-jwt-assertion|set-cookie|password|token|access_token|refresh_token|api_key|client_secret|jwt|secret|key)$/i;

const PII_KEY_PATTERN = /^(email|phone|whatsapp_phone|to_phone|to_phone_e164|from_phone|from_phone_e164|name|first_name|last_name|tenant_id|user_id|user|address|ip|cf-connecting-ip|x-forwarded-for)$/i;

const REDACTED = '[redacted]';

function scrub(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => scrub(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k) || PII_KEY_PATTERN.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = scrub(v, seen);
    }
  }
  return out;
}

export function scrubPii<T>(event: T): T {
  if (event === null || event === undefined || typeof event !== 'object') return event;
  return scrub(event, new WeakSet()) as T;
}
