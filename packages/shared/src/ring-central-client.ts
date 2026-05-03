// packages/shared/src/ring-central-client.ts
// RingCentralClient — shared between icrv-voice and icrv-cron.
// Moved here to eliminate the cross-worker source import in icrv-cron.

import type { BaseEnv } from './types';
import { loadRcCredentials } from './credentials';

/** Minimal env shape needed by RingCentralClient. BaseEnv covers it. */
export type RcEnv = BaseEnv;

export class RingCentralClient {
  private constructor(
    private env: RcEnv,
    private credId: string,
    private server: string,
    private accessToken: string,
    private accessExpiresAt: number,
    private clientId: string,
    private clientSecret: string,
    private jwt: string,
    private metadata: Record<string, string>,
  ) {}

  static async fromCredential(credId: string, env: RcEnv): Promise<RingCentralClient> {
    const cred = await loadRcCredentials(env, credId);
    const cached = await env.KV_OAUTH.get(`rc_access:${credId}`);
    let access = '', expires = 0;
    if (cached) {
      const j = JSON.parse(cached) as { token: string; expires_at: number };
      if (j.expires_at > Date.now() + 60_000) { access = j.token; expires = j.expires_at; }
    }
    if (!access) {
      const tokRes = await fetch(`${cred.server}/restapi/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          Authorization:   `Basic ${btoa(`${cred.client_id}:${cred.client_secret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion:  cred.jwt,
        }),
      });
      if (!tokRes.ok) throw new Error(`rc_token_${tokRes.status}:${(await tokRes.text()).slice(0, 200)}`);
      const data = await tokRes.json() as { access_token: string; expires_in: number };
      access = data.access_token;
      expires = Date.now() + (data.expires_in - 30) * 1000;
      await env.KV_OAUTH.put(
        `rc_access:${credId}`,
        JSON.stringify({ token: access, expires_at: expires }),
        { expirationTtl: Math.max(60, data.expires_in - 30) },
      );
    }
    return new RingCentralClient(env, credId, cred.server, access, expires, cred.client_id, cred.client_secret, cred.jwt, cred.metadata);
  }

  async placeRingOut(opts: {
    to: string; from: string; correlationId: string; elSipUri?: string;
  }): Promise<{ session_id?: string; ring_out_id?: string }> {
    const elTrunkNumber = this.metadata['el_trunk_phone_e164'] ?? opts.from;
    const body = {
      from:       { phoneNumber: opts.from },
      to:         { phoneNumber: opts.to },
      callerId:   { phoneNumber: opts.from },
      playPrompt: false,
      country:    { isoCode: 'US' },
    };
    const res = await fetch(`${this.server}/restapi/v1.0/account/~/extension/~/ring-out`, {
      method: 'POST',
      headers: {
        Authorization:    `Bearer ${this.accessToken}`,
        'Content-Type':   'application/json',
        'X-ICRV-Session': opts.correlationId,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`rc_ringout_${res.status}:${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { id?: string; uri?: string; status?: { callStatus?: string } };

    let telephonySessionId: string | undefined;
    try {
      const active = await fetch(`${this.server}/restapi/v1.0/account/~/extension/~/active-calls?direction=Outbound`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (active.ok) {
        const aData = await active.json() as { records?: Array<{ telephonySessionId?: string; to?: { phoneNumber?: string } }> };
        const match = (aData.records ?? []).find(r => r.to?.phoneNumber === opts.to || r.to?.phoneNumber === opts.to.replace('+', ''));
        telephonySessionId = match?.telephonySessionId;
      }
    } catch {/* ignore — webhook will set it */}

    void elTrunkNumber;
    return { session_id: telephonySessionId, ring_out_id: data.id };
  }

  async renewSubscription(subId: string): Promise<void> {
    await fetch(`${this.server}/restapi/v1.0/subscription/${subId}/renew`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }

  async getRecordingForSession(sessionId: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    const list = await fetch(`${this.server}/restapi/v1.0/account/~/telephony/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!list.ok) return null;
    const session = await list.json() as { recordings?: Array<{ id: string; contentUri?: string }> };
    const rec = session.recordings?.[0];
    if (!rec) return null;
    const recRes = await fetch(`${this.server}/restapi/v1.0/account/~/recording/${rec.id}/content`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!recRes.ok) return null;
    const buf = await recRes.arrayBuffer();
    return { body: buf, contentType: recRes.headers.get('Content-Type') ?? 'audio/mpeg' };
  }

  async hangUpSession(sessionId: string): Promise<void> {
    await fetch(`${this.server}/restapi/v1.0/account/~/telephony/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }
}
