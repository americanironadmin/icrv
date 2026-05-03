// packages/shared/src/crypto.ts
// Crypto primitives used across all ICRV workers.
// All operations use the Web Crypto API (available in Cloudflare Workers).

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers & time
// ─────────────────────────────────────────────────────────────────────────────

export function uuidv4(): string {
  return crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function nowMs(): number {
  return Date.now();
}

export function idempKey(msgId: string): string {
  return `idemp:${msgId}`;
}

/**
 * Hourly sliding-window key: changes every hour so the window auto-resets.
 * Used with KV expirationTtl = windowSecs to bound storage growth.
 */
export function rateLimitKey(tenantId: string, channel: string): string {
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  return `rate:${tenantId}:${channel}:${hourBucket}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64 helpers
// ─────────────────────────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  // btoa works on strings; convert byte-by-byte
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function fromBase64Url(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  return fromBase64(padded + '='.repeat(pad));
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope encryption — AES-256-GCM with HKDF-derived DEK
//
// Schema: api_credentials & oauth_tokens store:
//   cipher_text TEXT   — base64 AES-256-GCM ciphertext (without auth tag)
//   iv          TEXT   — base64 12-byte IV
//   auth_tag    TEXT   — base64 16-byte GCM auth tag
//   key_version INTEGER
//
// The master KEK lives only in Workers Secrets (MASTER_KEK).
// A per-tenant DEK is derived via HKDF(KEK, tenantId, keyVersion) — never stored.
// ─────────────────────────────────────────────────────────────────────────────

export async function deriveDek(
  masterKek: string,
  tenantId: string,
  keyVersion: number,
): Promise<CryptoKey> {
  const rawKek = new TextEncoder().encode(masterKek);
  const baseKey = await crypto.subtle.importKey('raw', rawKek, 'HKDF', false, ['deriveKey']);

  const info = new TextEncoder().encode(`icrv:dek:${tenantId}:v${keyVersion}`);
  const salt = new TextEncoder().encode('icrv-envelope-v1');

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSecret(
  plaintext: string,
  masterKek: string,
  tenantId: string,
  keyVersion: number,
): Promise<{ cipher_text: string; iv: string; auth_tag: string; key_version: number }> {
  const dek = await deriveDek(masterKek, tenantId, keyVersion);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);

  // AES-GCM encrypt: output = ciphertext || 16-byte auth tag
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, dek, data);

  const buf = new Uint8Array(encrypted);
  const ciphertext = buf.slice(0, buf.length - 16);
  const authTag    = buf.slice(buf.length - 16);

  return {
    cipher_text: toBase64(ciphertext),
    iv:          toBase64(iv),
    auth_tag:    toBase64(authTag),
    key_version: keyVersion,
  };
}

export async function decryptSecret(
  cipherText: string,
  iv: string,
  authTag: string,
  masterKek: string,
  tenantId: string,
  keyVersion: number,
): Promise<string> {
  const dek = await deriveDek(masterKek, tenantId, keyVersion);

  const ctBytes  = fromBase64(cipherText);
  const tagBytes = fromBase64(authTag);
  const ivBytes  = fromBase64(iv);

  // Re-combine ciphertext + auth tag as SubtleCrypto expects
  const combined = new Uint8Array(ctBytes.length + tagBytes.length);
  combined.set(ctBytes);
  combined.set(tagBytes, ctBytes.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
    dek,
    combined,
  );

  return new TextDecoder().decode(decrypted);
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC-SHA256 helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hmacSha256Bytes(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, message);
  return new Uint8Array(sig);
}

/** Constant-time string comparison to prevent timing attacks */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google JWT verification (Pub/Sub push endpoint authentication)
// ─────────────────────────────────────────────────────────────────────────────

interface GoogleJwt {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  exp: number;
  iat: number;
}

/**
 * Verify a Google OIDC token sent by Cloud Pub/Sub push subscriptions.
 * Fetches Google's JWKS on first call; caches in the calling scope.
 *
 * @param token   Bearer token from Authorization header
 * @param audience Exact audience string registered in Pub/Sub push config (our endpoint URL)
 */
export async function verifyGoogleJwt(token: string, audience: string): Promise<GoogleJwt> {
  // Split JWT
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_jwt');

  const header  = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as { kid: string; alg: string };
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as GoogleJwt;

  // Basic claim checks (before fetching JWKS)
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now)          throw new Error('jwt_expired');
  if (payload.iat > now + 30)     throw new Error('jwt_iat_future');
  if (payload.aud !== audience)   throw new Error(`jwt_aud_mismatch: got ${payload.aud}`);
  if (
    payload.iss !== 'accounts.google.com' &&
    payload.iss !== 'https://accounts.google.com'
  ) throw new Error('jwt_bad_issuer');

  // Fetch Google's public keys
  const jwksRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!jwksRes.ok) throw new Error('jwks_fetch_failed');
  const jwks = await jwksRes.json() as { keys: Array<{ kid: string; n: string; e: string; kty: string; alg: string; use: string }> };

  const key = jwks.keys.find(k => k.kid === header.kid);
  if (!key) throw new Error('jwks_kid_not_found');

  // Import RSA public key
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  // Verify signature
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature    = fromBase64Url(parts[2]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signingInput);
  if (!valid) throw new Error('jwt_signature_invalid');

  return payload;
}
