// workers/icrv-api/src/index.ts
// IRON CUSTOMER REACH VMAX — API gateway worker.
//
// Mounts:
//   /v1/auth/*               authentication & current user
//   /v1/contacts/*           CRUD + bulk upload
//   /v1/campaigns/*          CRUD + lifecycle
//   /v1/templates/*          CRUD
//   /v1/calls/*              monitoring, transcripts, end
//   /v1/logs/*               unified activity feed
//   /v1/dashboard/*          stats, activity, service status
//   /v1/agent-controls/*     proxied to icrv-agent (service binding)
//
// Registers four Durable Object classes that other workers reference via
// `script_name = "icrv-api"` in their wrangler.toml.

import { Hono } from 'hono';
import { withSentry } from '@sentry/cloudflare';
import type { ExportedHandler as CFExportedHandler } from '@cloudflare/workers-types';
import { authMiddleware, requireNotViewer } from './auth';
import type { HonoCtx, ApiEnv } from './env';
import { createContactsRouter }  from './routes/contacts';
import { createCampaignsRouter, createTemplatesRouter } from './routes/campaigns';
import { createCallsRouter }     from './routes/calls';
import { createDashboardRouter, createLogsRouter, createAuthRouter, createAdminRouter } from './routes/misc';
import { createSettingsRouter } from './routes/settings';
import { createEmailAuthRouter } from './routes/email-auth';
import { createLeadsRouter } from './routes/leads';
import { createAnalyticsRouter } from './routes/analytics';
import { createApiKeysRouter } from './routes/api-keys';
import { createBouncesRouter } from './routes/bounces';
import { createContactsBulkRouter } from './routes/contacts-bulk';
import { createQuotesRouter } from './routes/quotes';
import { createWebhooksRouter } from './routes/webhooks';
import { handleUnsubscribe, handleTrackOpen, handleTrackClick, handleConsentResponse } from './routes/public';
import { encryptSecret, uuidv4, nowISO } from '@icrv/shared/crypto';
import { rateLimit, cfIp } from '@icrv/shared/rate-limit';
import { scrubPii } from '@icrv/shared/sentry-scrub';

// Single source of truth for the CORS allowlist. The pages.dev origin is kept
// during the cutover so preview deploys can still hit the API; remove once the
// preview window closes.
export const CORS_ALLOWLIST: ReadonlySet<string> = new Set([
  'https://icrv.americanironus.com',
  'http://localhost:5173',
  'https://icrv-dashboard.pages.dev',
]);

// Re-export Durable Object classes so Cloudflare can register them on this script.
export { CampaignCoordinatorDO } from './do/campaign-coordinator';
export { ContactInboxDO }        from './do/contact-inbox';
export { VoiceSessionDO }        from './do/voice-session';
export { OAuthRotatorDO }        from './do/oauth-rotator';

const app = new Hono<HonoCtx>();

// ─── CORS — single source of truth ────────────────────────────────────────────
// Reflects allowlisted origins, always emits Vary: Origin (closes M2 — would
// otherwise be a CORS-poisoning bug if a CDN ever cached responses). Rejects
// credentialed preflights from non-allowlisted origins by responding without
// the credentials header (browser then blocks the request).
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') ?? '';
  const allowed = CORS_ALLOWLIST.has(origin);

  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cf-Access-Jwt-Assertion',
      'Access-Control-Max-Age':       '600',
      'Vary':                         'Origin',
    };
    if (allowed) {
      headers['Access-Control-Allow-Origin']      = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    return new Response(null, { status: 204, headers });
  }

  await next();

  // Always emit Vary: Origin whenever the response is origin-dependent so any
  // future cache layer keys correctly.
  const existingVary = c.res.headers.get('Vary');
  c.res.headers.set('Vary', existingVary && !/(^|,\s*)Origin(\s*,|$)/i.test(existingVary)
    ? `${existingVary}, Origin`
    : 'Origin');

  if (allowed) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  }
});

app.get('/health', (c) => c.json({ ok: true, service: 'icrv-api', ts: new Date().toISOString() }));

// ─── Public endpoints (NO Access — must be on Access bypass list) ─────────
// /u/:token       — CAN-SPAM unsubscribe (Phase 2)
// /track/open     — open pixel (Phase 3)
// /r              — click redirect (Phase 3)
app.get('/u/:token', handleUnsubscribe);
app.get('/track/open', handleTrackOpen);
app.get('/r', handleTrackClick);
// /consent/:token?action=accept|decline — v2.6 consent capture (PUBLIC, must be on Access bypass)
app.get('/consent/:token', handleConsentResponse);

// CSP violation receiver. No auth, no CORS — browsers POST these directly.
// Accepts both `application/csp-report` (legacy) and `application/reports+json`.
// Logs to console for now; Sentry will pick these up once PR 4 lands.
app.post('/csp-report', async (c) => {
  try {
    const body = await c.req.text();
    console.warn('[csp-report]', body.slice(0, 4096));
  } catch (err) {
    console.warn('[csp-report] parse failed', (err as Error).message);
  }
  return new Response(null, { status: 204 });
});

// ─── Google OAuth callback — mounted OUTSIDE /v1 (comes from Google, no user JWT) ─
// Redirect URI registered in Google Cloud Console:
//   https://icrv-api.americanironadmin.workers.dev/oauth/google/callback
app.get('/oauth/google/callback', async (c) => {
  const code  = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  const frontendBase = 'https://icrv.americanironus.com';

  if (error) {
    return c.redirect(`${frontendBase}?google_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return c.redirect(`${frontendBase}?google_error=missing_code_or_state`);
  }

  // Validate one-time state (CSRF protection)
  const stateRaw = await c.env.KV_OAUTH.get(`oauth_state:${state}`);
  if (!stateRaw) {
    return c.redirect(`${frontendBase}?google_error=invalid_or_expired_state`);
  }
  const { tenant_id } = JSON.parse(stateRaw) as { tenant_id: string; user_id: string };
  await c.env.KV_OAUTH.delete(`oauth_state:${state}`); // one-time use

  // Exchange code for access + refresh tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  'https://icrv-api.americanironadmin.workers.dev/oauth/google/callback',
      grant_type:    'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error('[google_callback] token exchange failed', errText);
    return c.redirect(`${frontendBase}?google_error=token_exchange_failed`);
  }
  const tokenData = await tokenRes.json() as {
    access_token: string; refresh_token?: string; expires_in: number; scope: string;
  };
  if (!tokenData.refresh_token) {
    // No refresh_token — user may have previously authorised without revoking.
    // Force re-consent by adding prompt=consent in the start URL (already done).
    return c.redirect(`${frontendBase}?google_error=no_refresh_token`);
  }

  // Fetch user email to label the credential
  let userEmail: string | null = null;
  try {
    const uRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (uRes.ok) {
      const uData = await uRes.json() as { email?: string };
      userEmail = uData.email ?? null;
    }
  } catch { /* non-fatal */ }

  const now     = nowISO();
  const tokenId = uuidv4();

  // Encrypt refresh token with tenant-scoped DEK
  const enc = await encryptSecret(tokenData.refresh_token, c.env.MASTER_KEK, tenant_id, 1);

  // Deactivate any previous Gmail tokens for this tenant
  await c.env.DB.prepare(
    `UPDATE oauth_tokens SET is_active=0, updated_at=? WHERE tenant_id=? AND provider='gmail'`,
  ).bind(now, tenant_id).run();

  // Insert new token
  await c.env.DB.prepare(
    `INSERT INTO oauth_tokens (id,tenant_id,provider,email,refresh_cipher,refresh_iv,refresh_auth_tag,key_version,scopes,is_active,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
  ).bind(tokenId, tenant_id, 'gmail', userEmail, enc.cipher_text, enc.iv, enc.auth_tag, enc.key_version, tokenData.scope, now, now).run();

  // Upsert api_credentials row so dashboard /status shows Gmail as connected
  const existingCred = await c.env.DB.prepare(
    `SELECT id FROM api_credentials WHERE tenant_id=? AND provider='gmail' AND is_active=1 LIMIT 1`,
  ).bind(tenant_id).first<{ id: string }>();
  if (!existingCred) {
    const credId  = uuidv4();
    const credEnc = await encryptSecret(
      JSON.stringify({ oauth_token_id: tokenId, email: userEmail }),
      c.env.MASTER_KEK, tenant_id, 1,
    );
    await c.env.DB.prepare(
      `INSERT INTO api_credentials (id,tenant_id,provider,label,cipher_text,iv,auth_tag,key_version,is_active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
    ).bind(credId, tenant_id, 'gmail', userEmail ?? 'Gmail', credEnc.cipher_text, credEnc.iv, credEnc.auth_tag, credEnc.key_version, now, now).run();
  }

  const emailParam = userEmail ? `&google_email=${encodeURIComponent(userEmail)}` : '';
  return c.redirect(`${frontendBase}?google_connected=1${emailParam}`);
});

const v1 = new Hono<HonoCtx>();

// Rate limit before auth so brute-force probes burn KV writes, not DB lookups.
// Tight cap on /v1/auth/*; broader cap on the rest of /v1/*.
v1.use('/auth/*', rateLimit({
  max: 10, windowSec: 60,
  keyFn: (c) => `auth:${cfIp(c)}`,
}));
v1.use('*', rateLimit({
  max: 120, windowSec: 60,
  keyFn: (c) => `api:${cfIp(c)}:${(c.get('tenant_id') as string | undefined) ?? 'anon'}`,
}));

v1.use('*', authMiddleware);

v1.route('/auth',      createAuthRouter());
v1.route('/admin',     createAdminRouter());
v1.route('/contacts',  createContactsBulkRouter());  // /bulk + /consent-request + /consent-summary
v1.route('/contacts',  createContactsRouter());      // CRUD + bulk-upload
v1.route('/campaigns', createCampaignsRouter());
v1.route('/templates', createTemplatesRouter());
v1.route('/calls',     createCallsRouter());
v1.route('/dashboard', createDashboardRouter());
v1.route('/logs',      createLogsRouter());
v1.route('/settings/api_webhooks', createApiKeysRouter());  // mounted BEFORE /settings so /generate-key matches first
v1.route('/settings',  createSettingsRouter());
v1.route('/auth',      createEmailAuthRouter());  // /v1/auth/check-{dkim,spf,dmarc} — same prefix as createAuthRouter, second mount adds these endpoints
v1.route('/leads',     createLeadsRouter());
v1.route('/analytics', createAnalyticsRouter());
v1.route('/bounces',   createBouncesRouter());
v1.route('/quotes',    createQuotesRouter());
v1.route('/webhooks',  createWebhooksRouter());

// /v1/agent-controls/* — defense-in-depth: viewers blocked at the gateway in
// addition to whatever icrv-agent enforces internally. Closes the M6 risk where
// a UI-only gate was the only barrier between viewers and the kill-switch.
v1.use('/agent-controls/*', requireNotViewer);

// /v1/agent-controls/* — proxy to icrv-agent via service binding.
// Identity is forwarded as trusted X-Tenant-ID / X-User-ID / X-User-Role headers
// because no public route reaches the agent worker directly.
// NOTE: We explicitly reconstruct the response with CORS headers because the
// service-binding Response has immutable headers — Hono's post-middleware CORS
// injection via c.res.headers.set() silently fails on immutable header objects.
v1.all('/agent-controls/*', async (c) => {
  const u = new URL(c.req.url);
  const targetPath = u.pathname; // keep /v1/agent-controls intact — agent mounts at /v1/agent-controls
  const targetUrl  = `https://icrv-agent.internal${targetPath}${u.search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Tenant-ID', c.get('tenant_id'));
  headers.set('X-User-ID',   c.get('user_id'));
  headers.set('X-User-Role', c.get('user_role'));
  headers.delete('Cookie'); headers.delete('Authorization');
  const init: RequestInit = {
    method:  c.req.method,
    headers,
    body:    ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
  };
  const agentRes = await c.env.AGENT.fetch(new Request(targetUrl, init));

  // Clone the response so CORS headers are mutable. Pull from the unified
  // CORS_ALLOWLIST constant and always set Vary: Origin so the answer is
  // correctly cache-keyed if a CDN ever sits in front.
  const origin = c.req.header('Origin') ?? '';
  const newHeaders = new Headers(agentRes.headers);
  const existingVary = newHeaders.get('Vary');
  newHeaders.set('Vary', existingVary && !/(^|,\s*)Origin(\s*,|$)/i.test(existingVary)
    ? `${existingVary}, Origin`
    : 'Origin');
  if (CORS_ALLOWLIST.has(origin)) {
    newHeaders.set('Access-Control-Allow-Origin', origin);
    newHeaders.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(agentRes.body, {
    status:     agentRes.status,
    statusText: agentRes.statusText,
    headers:    newHeaders,
  });
});

app.route('/v1', v1);

app.notFound((c) => c.json({ error: 'not_found', path: new URL(c.req.url).pathname }, 404));
app.onError((err, c) => {
  console.error('[icrv-api]', err);
  return c.json({ error: 'internal_error', detail: (err as Error).message }, 500);
});

const handler: ExportedHandler<ApiEnv> = { fetch: app.fetch };

// `CFExportedHandler` is the same shape as the global `ExportedHandler`, but
// importing it explicitly from `@cloudflare/workers-types` aligns the type
// reference TypeScript sees here with the one Sentry's d.ts imports — without
// this they're "the same" name but considered structurally different through
// the lib/global path, which fails the `extends ExportedHandler<any>` check.
export default withSentry<CFExportedHandler<ApiEnv>>(
  (env) => ({
    dsn:               env.SENTRY_DSN ?? '',
    environment:       env.ENVIRONMENT ?? 'production',
    tracesSampleRate:  0.1,
    sendDefaultPii:    false,
    beforeSend:        scrubPii,
    beforeSendTransaction: scrubPii,
  }),
  handler as CFExportedHandler<ApiEnv>,
);
