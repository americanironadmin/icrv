// workers/icrv-api/src/env.ts
import type { BaseEnv } from '@icrv/shared/types';

export interface ApiEnv extends BaseEnv {
  // JTI revocation list (populated by /v1/auth/logout, checked by authMiddleware).
  KV_REVOKED: KVNamespace;
  // Cloudflare Access JWKS cache (1-hour TTL) — avoids a fetch per request.
  KV_JWKS:    KVNamespace;

  // Service bindings to other workers
  AGENT: Fetcher;   // icrv-agent (AI agent control plane)
  VOICE: Fetcher;   // icrv-voice (credential bootstrap)

  // Cloudflare Access verification
  CF_ACCESS_TEAM_DOMAIN: string;   // e.g. "acme.cloudflareaccess.com"
  CF_ACCESS_AUD:         string;   // application audience tag

  // Internal JWT signing
  JWT_SIGNING_KEY:       string;   // 32-byte hex secret (HS256)

  // For OAuth proxy support
  GOOGLE_CLIENT_ID:      string;
  GOOGLE_CLIENT_SECRET:  string;

  // Third-party integration secrets (used by bootstrap-credentials endpoint)
  EL_API_KEY:            string;   // ElevenLabs API key
  EL_LLM_SHARED_SECRET:  string;   // Shared secret for EL → our LLM proxy auth
  RC_JWT:                string;   // RingCentral JWT credential (may be JSON object)
  RC_WEBHOOK_TOKEN:      string;   // Token for RC webhook HMAC verification
}

export type ApiCtxVars = {
  tenant_id: string;
  user_id:   string;
  user_role: 'admin' | 'operator' | 'viewer';
  email:     string;
  jwt_jti?:  string;     // present when the verified JWT carries a `jti` claim
  jwt_exp?:  number;     // unix seconds — used to set KV_REVOKED TTL
};

export type HonoCtx = { Bindings: ApiEnv; Variables: ApiCtxVars };
