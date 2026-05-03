// workers/icrv-api/src/routes/calls.ts
// /v1/calls — list, get, transcript, active, end, session-state

import { Hono } from 'hono';
import { nowISO } from '@icrv/shared/crypto';
import type { HonoCtx } from '../env';

interface CallRow {
  id: string; tenant_id: string; contact_id: string; campaign_id?: string|null;
  direction: string; status: string; duration_seconds?: number|null;
  correlation_id: string; rc_session_id?: string|null; el_conversation_id?: string|null;
  outcome?: string|null; recording_uri?: string|null; transcript_uri?: string|null;
  started_at?: string|null; answered_at?: string|null; ended_at?: string|null;
  created_at: string; updated_at: string;
  contact_name?: string|null; campaign_name?: string|null; phone?: string|null;
}

function shapeCall(r: CallRow) {
  return {
    id: r.id, tenant_id: r.tenant_id, contact_id: r.contact_id,
    contact_name: r.contact_name ?? undefined, campaign_id: r.campaign_id ?? undefined,
    direction: r.direction, status: r.status,
    duration_seconds: r.duration_seconds ?? undefined,
    correlation_id: r.correlation_id, outcome: r.outcome ?? undefined,
    recording_url: r.recording_uri ?? undefined, transcript_url: r.transcript_uri ?? undefined,
    started_at: r.started_at ?? r.created_at, ended_at: r.ended_at ?? undefined, created_at: r.created_at,
  };
}

export function createCallsRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/active', async (c) => {
    const tenantId = c.get('tenant_id');
    const r = await c.env.DB.prepare(
      `SELECT cl.*, ct.name AS contact_name, ct.phone_e164 AS phone, cm.name AS campaign_name
       FROM call_logs cl
       JOIN contacts ct ON ct.id = cl.contact_id
       LEFT JOIN campaigns cm ON cm.id = cl.campaign_id
       WHERE cl.tenant_id = ? AND cl.status IN ('queued','ringing','connected')
       ORDER BY cl.created_at DESC LIMIT 50`,
    ).bind(tenantId).all<CallRow>();

    // Enrich with VoiceSessionDO transcript preview if available
    const calls = await Promise.all((r.results ?? []).map(async row => {
      let transcript_preview: string | undefined;
      let speaker_state: 'ai_speaking'|'contact_speaking'|'silence'|'unknown' = 'unknown';
      try {
        const stub = c.env.VOICE_SESSION_DO.get(c.env.VOICE_SESSION_DO.idFromName(row.correlation_id));
        const sres = await stub.fetch('http://do/state', { method: 'GET' });
        if (sres.ok) {
          const s = await sres.json() as { transcript_preview?: string; speaker_state?: typeof speaker_state };
          transcript_preview = s.transcript_preview;
          speaker_state = s.speaker_state ?? 'unknown';
        }
      } catch { /* DO may not exist for queued calls — fine */ }
      return {
        ...shapeCall(row),
        contact_phone: row.phone ?? undefined,
        rc_session_id: row.rc_session_id ?? undefined,
        el_conversation_id: row.el_conversation_id ?? undefined,
        transcript_preview, speaker_state,
      };
    }));
    return c.json({ calls, count: calls.length });
  });

  app.get('/', async (c) => {
    const tenantId = c.get('tenant_id');
    const q = c.req.query();
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const perPage = Math.min(200, Math.max(1, parseInt(q.per_page ?? '25', 10)));
    const where: string[] = ['cl.tenant_id = ?']; const binds: unknown[] = [tenantId];
    if (q.direction)  { where.push('cl.direction = ?'); binds.push(q.direction); }
    if (q.status)     { where.push('cl.status = ?');    binds.push(q.status); }
    if (q.contact_id) { where.push('cl.contact_id = ?'); binds.push(q.contact_id); }
    if (q.date_from)  { where.push("cl.created_at >= ?"); binds.push(q.date_from); }
    if (q.date_to)    { where.push("cl.created_at <= ?"); binds.push(q.date_to); }
    const order = q.sort === 'asc' ? 'ASC' : 'DESC';

    const total = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM call_logs cl WHERE ${where.join(' AND ')}`,
    ).bind(...binds).first<{ n: number }>())?.n ?? 0;

    const r = await c.env.DB.prepare(
      `SELECT cl.*, ct.name AS contact_name, cm.name AS campaign_name
       FROM call_logs cl
       JOIN contacts ct ON ct.id = cl.contact_id
       LEFT JOIN campaigns cm ON cm.id = cl.campaign_id
       WHERE ${where.join(' AND ')}
       ORDER BY cl.created_at ${order} LIMIT ? OFFSET ?`,
    ).bind(...binds, perPage, (page - 1) * perPage).all<CallRow>();

    return c.json({ calls: (r.results ?? []).map(shapeCall), total, page, per_page: perPage });
  });

  app.get('/session/:correlationId', async (c) => {
    const tenantId = c.get('tenant_id');
    const corr = c.req.param('correlationId');
    const row = await c.env.DB.prepare(
      `SELECT cl.*, ct.name AS contact_name, ct.phone_e164 AS phone, cm.name AS campaign_name
       FROM call_logs cl
       JOIN contacts ct ON ct.id = cl.contact_id
       LEFT JOIN campaigns cm ON cm.id = cl.campaign_id
       WHERE cl.correlation_id = ? AND cl.tenant_id = ?`,
    ).bind(corr, tenantId).first<CallRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);

    let transcript_preview: string | undefined;
    let speaker_state: 'ai_speaking'|'contact_speaking'|'silence'|'unknown' = 'unknown';
    try {
      const stub = c.env.VOICE_SESSION_DO.get(c.env.VOICE_SESSION_DO.idFromName(corr));
      const sres = await stub.fetch('http://do/state', { method: 'GET' });
      if (sres.ok) {
        const s = await sres.json() as { transcript_preview?: string; speaker_state?: typeof speaker_state };
        transcript_preview = s.transcript_preview;
        speaker_state = s.speaker_state ?? 'unknown';
      }
    } catch { /* no DO */ }
    return c.json({
      ...shapeCall(row),
      contact_phone: row.phone ?? undefined,
      rc_session_id: row.rc_session_id ?? undefined,
      el_conversation_id: row.el_conversation_id ?? undefined,
      transcript_preview, speaker_state,
    });
  });

  app.get('/:id/transcript', async (c) => {
    const tenantId = c.get('tenant_id');
    const id = c.req.param('id');
    const call = await c.env.DB.prepare(
      `SELECT id, transcript_uri FROM call_logs WHERE id = ? AND tenant_id = ?`,
    ).bind(id, tenantId).first<{ id: string; transcript_uri?: string|null }>();
    if (!call) return c.json({ error: 'not_found' }, 404);

    const rows = await c.env.DB.prepare(
      `SELECT speaker, text, timestamp_ms, confidence FROM call_transcripts
       WHERE call_log_id = ? ORDER BY timestamp_ms ASC`,
    ).bind(id).all<{ speaker: 'ai'|'contact'; text: string; timestamp_ms: number; confidence?: number|null }>();

    const segments = (rows.results ?? []).map(r => ({
      speaker: r.speaker, text: r.text, timestamp_ms: r.timestamp_ms,
      confidence: r.confidence ?? undefined,
    }));
    const transcript = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
    return c.json({ transcript, segments });
  });

  app.get('/:id', async (c) => {
    const row = await c.env.DB.prepare(
      `SELECT cl.*, ct.name AS contact_name FROM call_logs cl
       JOIN contacts ct ON ct.id = cl.contact_id
       WHERE cl.id = ? AND cl.tenant_id = ?`,
    ).bind(c.req.param('id'), c.get('tenant_id')).first<CallRow>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(shapeCall(row));
  });

  app.post('/:id/end', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const id = c.req.param('id'); const tenantId = c.get('tenant_id');
    const row = await c.env.DB.prepare(
      `SELECT id, correlation_id, status FROM call_logs WHERE id = ? AND tenant_id = ?`,
    ).bind(id, tenantId).first<{ id: string; correlation_id: string; status: string }>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (['ended', 'failed', 'voicemail', 'no_answer'].includes(row.status)) {
      return c.json({ ended: true, already: true });
    }

    // Tell the VoiceSessionDO to terminate via RingCentral
    try {
      const stub = c.env.VOICE_SESSION_DO.get(c.env.VOICE_SESSION_DO.idFromName(row.correlation_id));
      await stub.fetch('http://do/end', { method: 'POST' });
    } catch { /* best effort — DB will reflect via webhook anyway */ }

    await c.env.DB.prepare(
      `UPDATE call_logs SET status='ended', ended_at=?, updated_at=? WHERE id=?`,
    ).bind(nowISO(), nowISO(), id).run();
    return c.json({ ended: true });
  });

  return app;
}
