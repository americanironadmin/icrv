// workers/icrv-api/src/do/voice-session.ts
// One DO per active call. Identified by `correlation_id`.
// Receives:
//  - /init                 (POST) — call_log info, RC + EL credential ids
//  - /event                (POST) — telemetry from RC/EL webhooks
//  - /transcript           (POST) — incremental transcript chunk
//  - /state                (GET)  — current snapshot
//  - /end                  (POST) — request RC to hang up

import { decryptSecret } from '@icrv/shared/crypto';

interface PersistedState {
  correlation_id: string;
  tenant_id: string;
  call_log_id: string;
  rc_session_id?: string;
  rc_party_id?: string;
  el_conversation_id?: string;
  status: 'queued'|'ringing'|'connected'|'ended'|'failed'|'voicemail'|'no_answer';
  speaker_state: 'ai_speaking'|'contact_speaking'|'silence'|'unknown';
  transcript_segments: Array<{ speaker: 'ai'|'contact'; text: string; t_ms: number }>;
  rc_credential_id?: string;
  el_credential_id?: string;
  started_at: string;
  updated_at: string;
}

const STORAGE_KEY = 'voice_state';
const TRANSCRIPT_WINDOW = 80;

interface DOEnv {
  DB: D1Database;
  MASTER_KEK: string;
}

export class VoiceSessionDO {
  private state: DurableObjectState;
  private env: DOEnv;
  private mem: PersistedState | null = null;

  constructor(state: DurableObjectState, env: DOEnv) {
    this.state = state; this.env = env;
  }

  private async load(): Promise<PersistedState | null> {
    if (this.mem) return this.mem;
    const stored = await this.state.storage.get<PersistedState>(STORAGE_KEY);
    this.mem = stored ?? null;
    return this.mem;
  }
  private async persist(): Promise<void> {
    if (this.mem) await this.state.storage.put(STORAGE_KEY, this.mem);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/init' && req.method === 'POST') {
      const body = await req.json() as {
        correlation_id: string; tenant_id: string; call_log_id: string;
        rc_credential_id: string; el_credential_id: string;
      };
      const fresh: PersistedState = {
        correlation_id: body.correlation_id, tenant_id: body.tenant_id,
        call_log_id: body.call_log_id,
        rc_credential_id: body.rc_credential_id,
        el_credential_id: body.el_credential_id,
        status: 'queued', speaker_state: 'unknown',
        transcript_segments: [],
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.mem = fresh;
      await this.persist();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/event' && req.method === 'POST') {
      const s = await this.load();
      if (!s) return new Response('not_initialised', { status: 400 });
      const body = await req.json() as {
        rc_session_id?: string; rc_party_id?: string; el_conversation_id?: string;
        status?: PersistedState['status']; speaker_state?: PersistedState['speaker_state'];
      };
      if (body.rc_session_id) s.rc_session_id = body.rc_session_id;
      if (body.rc_party_id)   s.rc_party_id   = body.rc_party_id;
      if (body.el_conversation_id) s.el_conversation_id = body.el_conversation_id;
      if (body.status)        s.status        = body.status;
      if (body.speaker_state) s.speaker_state = body.speaker_state;
      s.updated_at = new Date().toISOString();
      await this.persist();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/transcript' && req.method === 'POST') {
      const s = await this.load();
      if (!s) return new Response('not_initialised', { status: 400 });
      const body = await req.json() as { speaker: 'ai'|'contact'; text: string; t_ms: number };
      s.transcript_segments.push(body);
      while (s.transcript_segments.length > TRANSCRIPT_WINDOW) s.transcript_segments.shift();
      s.speaker_state = body.speaker === 'ai' ? 'ai_speaking' : 'contact_speaking';
      s.updated_at = new Date().toISOString();
      await this.persist();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/state' && req.method === 'GET') {
      const s = await this.load();
      if (!s) return Response.json({ status: 'unknown' });
      const recent = s.transcript_segments.slice(-3).map(x => `${x.speaker}: ${x.text}`).join(' | ');
      return Response.json({
        correlation_id: s.correlation_id,
        status: s.status, speaker_state: s.speaker_state,
        transcript_preview: recent,
        rc_session_id: s.rc_session_id, el_conversation_id: s.el_conversation_id,
      });
    }

    if (url.pathname === '/end' && req.method === 'POST') {
      const s = await this.load();
      if (!s || !s.rc_credential_id || !s.rc_session_id) {
        if (s) { s.status = 'ended'; await this.persist(); }
        return Response.json({ ok: true, note: 'no_rc_session_active' });
      }
      try {
        // Resolve RC creds inline (DO has DB + MASTER_KEK)
        const credRow = await this.env.DB.prepare(
          `SELECT tenant_id, cipher_text, iv, auth_tag, key_version FROM api_credentials WHERE id = ?`,
        ).bind(s.rc_credential_id).first<{ tenant_id: string; cipher_text: string; iv: string; auth_tag: string; key_version: number }>();
        if (credRow) {
          const plain = await decryptSecret(
            credRow.cipher_text, credRow.iv, credRow.auth_tag,
            this.env.MASTER_KEK, credRow.tenant_id, credRow.key_version,
          );
          const rc = JSON.parse(plain) as { client_id: string; client_secret: string; jwt: string; server: string };
          // Token grant
          const tokRes = await fetch(`${rc.server}/restapi/oauth/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${btoa(`${rc.client_id}:${rc.client_secret}`)}`,
            },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: rc.jwt }),
          });
          if (tokRes.ok) {
            const { access_token } = await tokRes.json() as { access_token: string };
            // Hang up the telephony session
            await fetch(`${rc.server}/restapi/v1.0/account/~/telephony/sessions/${s.rc_session_id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${access_token}` },
            });
          }
        }
      } catch { /* best effort */ }
      s.status = 'ended'; s.updated_at = new Date().toISOString();
      await this.persist();
      return Response.json({ ok: true });
    }

    return new Response('not_found', { status: 404 });
  }
}
