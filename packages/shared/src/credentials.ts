// packages/shared/src/credentials.ts
// Decrypt api_credentials / oauth_tokens rows on demand. Plaintexts NEVER cross
// a Worker boundary — call this inside the worker that needs the secret.

import type {
  BaseEnv, WaCredentials, RcCredentials, ElCredentials, GmailRefreshCredentials,
} from './types';
import { decryptSecret } from './crypto';

interface ApiCredRow {
  id: string;
  tenant_id: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  metadata_json?: string | null;
}

interface OAuthRow {
  id: string;
  tenant_id: string;
  email?: string | null;
  refresh_cipher: string;
  refresh_iv: string;
  refresh_auth_tag: string;
  key_version: number;
}

async function loadApiCred(env: BaseEnv, id: string): Promise<{ row: ApiCredRow; plain: string }> {
  const row = await env.DB.prepare(
    `SELECT id, tenant_id, cipher_text, iv, auth_tag, key_version, metadata_json
     FROM api_credentials WHERE id = ? AND is_active = 1`,
  ).bind(id).first<ApiCredRow>();
  if (!row) throw new Error(`api_credential_not_found:${id}`);
  const plain = await decryptSecret(
    row.cipher_text, row.iv, row.auth_tag,
    env.MASTER_KEK, row.tenant_id, row.key_version,
  );
  return { row, plain };
}

export async function loadWaCredentials(env: BaseEnv, id: string): Promise<WaCredentials> {
  const { row, plain } = await loadApiCred(env, id);
  // plain text JSON: { access_token, business_id }
  const j = JSON.parse(plain) as { access_token: string; business_id?: string };
  const meta = row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, string> : {};
  return {
    access_token: j.access_token,
    business_id:  j.business_id ?? meta['business_id'] ?? '',
    phone_number_id: meta['phone_number_id'] ?? '',
  };
}

export async function loadRcCredentials(env: BaseEnv, id: string): Promise<RcCredentials & { metadata: Record<string, string> }> {
  const { row, plain } = await loadApiCred(env, id);
  const j = JSON.parse(plain) as { jwt: string; client_id: string; client_secret: string; server: string };
  const meta = row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, string> : {};
  return { ...j, metadata: meta };
}

export async function loadElCredentials(env: BaseEnv, id: string): Promise<ElCredentials & { metadata: Record<string, string> }> {
  const { row, plain } = await loadApiCred(env, id);
  const j = JSON.parse(plain) as { api_key: string };
  const meta = row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, string> : {};
  return { api_key: j.api_key, metadata: meta };
}

export async function loadGmailRefresh(env: BaseEnv, oauthTokenId: string): Promise<GmailRefreshCredentials & { tenant_id: string; email?: string | null; oauth_token_id: string }> {
  const row = await env.DB.prepare(
    `SELECT id, tenant_id, email, refresh_cipher, refresh_iv, refresh_auth_tag, key_version
     FROM oauth_tokens WHERE id = ? AND provider = 'gmail' AND is_active = 1`,
  ).bind(oauthTokenId).first<OAuthRow>();
  if (!row) throw new Error(`oauth_token_not_found:${oauthTokenId}`);
  const refresh = await decryptSecret(
    row.refresh_cipher, row.refresh_iv, row.refresh_auth_tag,
    env.MASTER_KEK, row.tenant_id, row.key_version,
  );
  // GOOGLE_CLIENT_ID / SECRET come from env (shared across tenants for one OAuth app)
  type EnvWithGoogle = BaseEnv & { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };
  const e = env as EnvWithGoogle;
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) {
    throw new Error('google_oauth_app_not_configured');
  }
  return {
    refresh_token:  refresh,
    client_id:      e.GOOGLE_CLIENT_ID,
    client_secret:  e.GOOGLE_CLIENT_SECRET,
    tenant_id:      row.tenant_id,
    email:          row.email,
    oauth_token_id: row.id,
  };
}
