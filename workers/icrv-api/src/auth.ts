// workers/icrv-api/src/auth.ts
// Resolves identity from either:
//  1. Cloudflare Access JWT (cookie CF_Authorization or Cf-Access-Jwt-Assertion header)
//  2. A Bearer JWT signed with JWT_SIGNING_KEY (used by service-to-service calls)
//
// On success, attaches { tenant_id, user_id, user_role } to the Hono context.

import type { Context } from 'hono';
import { fromBase64Url, hmacSha256Hex, timingSafeEqual } from '@icrv/shared/crypto';
import type { ApiEnv, ApiCtxVars, HonoCtx } from './env';

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  sub: string;          // user id
  email: string;
  tenant_id: string;
  role: 'admin' | 'operator' | 'viewer';
  exp: number;
  iat: number;
  jti?: string;         // JWT ID — required for revocation; CF Access mints it.
}

// HS256 verification for our internal JWTs
async function verifyHs256(token: string, secret: string): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt_malformed');
  const headerB64 = parts[0], payloadB64 = parts[1], sigB64 = parts[2];

  const header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerB64))) as { alg: string };
  if (header.alg !== 'HS256') throw new Error(`jwt_alg_unsupported:${header.alg}`);

  const expectedSig = await hmacSha256Hex(secret, `${headerB64}.${payloadB64}`);
  // sigB64 is base64url-encoded raw bytes; convert expected hex → base64url for compare
  const expectedHex = expectedSig;
  const sigBytes = fromBase64Url(sigB64);
  const sigHex = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  if (!timingSafeEqual(sigHex, expectedHex)) throw new Error('jwt_signature_invalid');

  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('jwt_expired');
  if (payload.iat > now + 30) throw new Error('jwt_iat_future');
  return payload;
}

// Cloudflare Access JWT verification — JWKS at /cdn-cgi/access/certs
async function verifyCfAccess(token: string, teamDomain: string, audTag: string): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('cf_jwt_malformed');
  const headerB64 = parts[0], payloadB64 = parts[1], sigB64 = parts[2];
  const header = JSON.parse(new TextDecoder().decode(fromBase64Url(headerB64))) as { kid: string; alg: string };

  const jwksRes = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!jwksRes.ok) throw new Error('cf_jwks_fetch_failed');
  const jwks = await jwksRes.json() as { keys: Array<JsonWebKey & { kid: string }> };

  const key = jwks.keys.find(k => k.kid === header.kid);
  if (!key) throw new Error('cf_jwks_kid_not_found');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    fromBase64Url(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) throw new Error('cf_jwt_signature_invalid');

  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as
    JwtPayload & { aud: string | string[] };

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('cf_jwt_expired');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(audTag)) throw new Error('cf_jwt_aud_mismatch');
  return payload;
}

// Resolve identity → DB lookup of users row → tenant + role
async function resolveUser(env: ApiEnv, email: string): Promise<{ user_id: string; tenant_id: string; role: 'admin'|'operator'|'viewer' }> {
  const row = await env.DB.prepare(
    `SELECT id, tenant_id, role FROM users WHERE email = ? AND status = 'active' LIMIT 1`,
  ).bind(email.toLowerCase()).first<{ id: string; tenant_id: string; role: 'admin'|'operator'|'viewer' }>();
  if (!row) throw new Error(`user_not_found:${email}`);
  return { user_id: row.id, tenant_id: row.tenant_id, role: row.role };
}

export async function authMiddleware(c: Context<HonoCtx>, next: () => Promise<void>): Promise<Response | void> {
  // 1) Cf Access — preferred when CF_Authorization is present
  const cfHeader = c.req.header('Cf-Access-Jwt-Assertion');
  const cookieHeader = c.req.header('Cookie') ?? '';
  const cfCookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookieHeader)?.[1];
  const cfToken = cfHeader ?? cfCookie;

  // 2) Internal Bearer
  const authHeader = c.req.header('Authorization') ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  let payload: JwtPayload | null = null;

  if (cfToken && c.env.CF_ACCESS_TEAM_DOMAIN && c.env.CF_ACCESS_AUD) {
    try {
      payload = await verifyCfAccess(cfToken, c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD);
    } catch (err) {
      // fall through to bearer
    }
  }

  if (!payload && bearer && c.env.JWT_SIGNING_KEY) {
    try {
      payload = await verifyHs256(bearer, c.env.JWT_SIGNING_KEY);
    } catch (err) {
      return c.json({ error: 'unauthorized', detail: (err as Error).message }, 401);
    }
  }

  if (!payload) return c.json({ error: 'unauthorized' }, 401);

  // Revocation check — POST /v1/auth/logout writes `revoked:<jti>` here.
  if (payload.jti && c.env.KV_REVOKED) {
    const revoked = await c.env.KV_REVOKED.get(`revoked:${payload.jti}`);
    if (revoked) return c.json({ error: 'unauthorized', detail: 'token_revoked' }, 401);
  }

  let tenantId: string, userId: string, role: 'admin'|'operator'|'viewer';

  if (payload.tenant_id && payload.role) {
    tenantId = payload.tenant_id; userId = payload.sub; role = payload.role;
  } else {
    // CF Access JWT — only carries email; resolve via DB
    try {
      const u = await resolveUser(c.env, payload.email);
      tenantId = u.tenant_id; userId = u.user_id; role = u.role;
    } catch (err) {
      return c.json({ error: 'user_not_provisioned', email: payload.email }, 403);
    }
  }

  const vars: ApiCtxVars = {
    tenant_id: tenantId,
    user_id:   userId,
    user_role: role,
    email:     payload.email,
  };
  c.set('tenant_id', vars.tenant_id);
  c.set('user_id',   vars.user_id);
  c.set('user_role', vars.user_role);
  c.set('email',     vars.email);
  if (payload.jti) c.set('jwt_jti', payload.jti);
  if (payload.exp) c.set('jwt_exp', payload.exp);

  await next();
}

// Role guard helper
export function requireRole(allowed: Array<'admin'|'operator'|'viewer'>) {
  return async (c: Context<HonoCtx>, next: () => Promise<void>): Promise<Response | void> => {
    const role = c.get('user_role');
    if (!allowed.includes(role)) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}

// Named middlewares so the admin-only and not-viewer gates are unified across
// routers and directly testable. Production routes mount these instead of
// reimplementing the role check inline.
export async function requireAdmin(c: Context<HonoCtx>, next: () => Promise<void>): Promise<Response | void> {
  if (c.get('user_role') !== 'admin') return c.json({ error: 'admin_required' }, 403);
  await next();
}

export async function requireNotViewer(c: Context<HonoCtx>, next: () => Promise<void>): Promise<Response | void> {
  if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
  await next();
}
