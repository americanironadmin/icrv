// workers/icrv-api/src/do/oauth-rotator.ts
// One DO per oauth_tokens.id. Provides a single-flight refresh of Gmail
// access tokens — concurrent callers get the same in-memory promise.
//
// HTTP:  GET /token   → { access_token, expires_in }
//
// Behaviour:
//   1. If a cached access_token exists and has > 60s left → return it.
//   2. Otherwise, kick off a refresh against Google's OAuth endpoint and
//      cache the new token (in DO storage + env.KV_OAUTH).
//   3. On error, return 502 with a structured reason.

import { decryptSecret } from '@icrv/shared/crypto';

interface CachedToken {
  access_token: string;
  expires_at: number; // epoch ms
}

interface DOEnv {
  DB: D1Database;
  KV_OAUTH: KVNamespace;
  MASTER_KEK: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

const STORAGE_KEY = 'cached_token';

export class OAuthRotatorDO {
  private state: DurableObjectState;
  private env: DOEnv;
  private inflight: Promise<CachedToken> | null = null;

  constructor(state: DurableObjectState, env: DOEnv) {
    this.state = state; this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/token' || req.method !== 'GET') {
      return new Response('not_found', { status: 404 });
    }
    const tokenId = (this.state.id.name ?? '').trim() || (req.headers.get('x-oauth-token-id') ?? '');
    if (!tokenId) return Response.json({ error: 'oauth_token_id_required' }, { status: 400 });

    try {
      const t = await this.getOrRefresh(tokenId);
      const remainSec = Math.max(0, Math.floor((t.expires_at - Date.now()) / 1000));
      return Response.json({ access_token: t.access_token, expires_in: remainSec });
    } catch (err) {
      return Response.json({ error: 'token_refresh_failed', detail: (err as Error).message }, { status: 502 });
    }
  }

  private async getOrRefresh(tokenId: string): Promise<CachedToken> {
    const cached = await this.state.storage.get<CachedToken>(STORAGE_KEY);
    if (cached && cached.expires_at > Date.now() + 60_000) return cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh(tokenId).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async refresh(tokenId: string): Promise<CachedToken> {
    const row = await this.env.DB.prepare(
      `SELECT id, tenant_id, refresh_cipher, refresh_iv, refresh_auth_tag, key_version
       FROM oauth_tokens WHERE id = ? AND is_active = 1`,
    ).bind(tokenId).first<{ id: string; tenant_id: string; refresh_cipher: string; refresh_iv: string; refresh_auth_tag: string; key_version: number }>();
    if (!row) throw new Error(`oauth_token_not_found:${tokenId}`);

    const refresh = await decryptSecret(
      row.refresh_cipher, row.refresh_iv, row.refresh_auth_tag,
      this.env.MASTER_KEK, row.tenant_id, row.key_version,
    );

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     this.env.GOOGLE_CLIENT_ID,
        client_secret: this.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refresh,
        grant_type:    'refresh_token',
      }),
    });

    if (!res.ok) throw new Error(`google_oauth_${res.status}:${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { access_token: string; expires_in: number; token_type: string };

    const next: CachedToken = {
      access_token: data.access_token,
      expires_at:   Date.now() + (data.expires_in - 30) * 1000,
    };
    await this.state.storage.put(STORAGE_KEY, next);
    // KV mirror so other workers can short-circuit (TTL = expires_in)
    await this.env.KV_OAUTH.put(`gmail_access:${tokenId}`, data.access_token, {
      expirationTtl: Math.max(60, data.expires_in - 30),
    });
    return next;
  }
}
