// workers/icrv-whatsapp/src/index.ts
// WhatsApp Cloud API integration. Sends template messages and processes
// inbound webhooks (which are persisted+enqueued by icrv-hooks; this worker
// is the wa_in queue consumer that does the heavy lifting and DB writes).

import type {
  BaseEnv, WaOutPayload, InboundWaPayload, RetryPayload,
} from '@icrv/shared/types';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import { rateAllow, isDuplicate, scheduleRetry } from '@icrv/shared/queue-helpers';
import { loadWaCredentials } from '@icrv/shared/credentials';

interface WaEnv extends BaseEnv {}

export default {
  async fetch(req: Request, env: WaEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'icrv-whatsapp' });
    if (url.pathname === '/send' && req.method === 'POST') {
      const payload = await req.json() as WaOutPayload;
      try {
        const r = await sendWhatsApp(payload, env);
        return Response.json(r);
      } catch (err) {
        return Response.json({ error: 'send_failed', detail: (err as Error).message }, { status: 502 });
      }
    }
    return new Response('not_found', { status: 404 });
  },

  async queue(batch: MessageBatch<WaOutPayload | InboundWaPayload | RetryPayload>, env: WaEnv): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body;

        // Outbound (queue: icrv-wa-out)
        if (body.type === 'wa_out' || (body.type === 'retry' && (body as RetryPayload).original_payload.type === 'wa_out')) {
          const p = (body.type === 'retry' ? (body as RetryPayload).original_payload : body) as WaOutPayload;
          if (await isDuplicate(env, p.id)) { msg.ack(); continue; }
          const allow = await rateAllow(env, p.tenant_id, 'whatsapp', 1000);
          if (!allow.allowed) { msg.retry({ delaySeconds: 60 }); continue; }
          await sendWhatsApp(p, env);
          msg.ack();
          continue;
        }

        // Inbound (queue: icrv-wa-in)
        if (body.type === 'wa_in') {
          await processInbound(body as InboundWaPayload, env);
          msg.ack();
          continue;
        }

        msg.ack();
      } catch (err) {
        const orig = msg.body.type === 'retry' ? (msg.body as RetryPayload).original_payload : msg.body;
        await scheduleRetry(env, msg.body.type === 'wa_out' ? 'icrv-wa-out' : 'icrv-wa-in', orig, (err as Error).message);
        msg.ack();
      }
    }
  },
} satisfies ExportedHandler<WaEnv, WaOutPayload | InboundWaPayload | RetryPayload>;

// ─── Outbound ───────────────────────────────────────────────────────────────

async function sendWhatsApp(p: WaOutPayload, env: WaEnv): Promise<{ ok: true; provider_msg_id: string }> {
  await env.DB.prepare(`UPDATE messages SET status='sending', updated_at=? WHERE id=?`)
    .bind(nowISO(), p.message_id).run();

  const action = await env.DB.prepare(
    `SELECT status FROM agent_actions WHERE result_ref = ? LIMIT 1`,
  ).bind(p.message_id).first<{ status: string }>();
  if (action?.status === 'revoked') {
    await env.DB.prepare(`UPDATE messages SET status='failed', error='action_revoked', updated_at=? WHERE id=?`)
      .bind(nowISO(), p.message_id).run();
    throw new Error('action_revoked');
  }

  const cred = await loadWaCredentials(env, p.credential_id);

  const url = `https://graph.facebook.com/v20.0/${cred.phone_number_id}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: p.to_phone_e164.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: p.template_name,
      language: { code: p.template_language },
      components: p.template_components,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    await env.DB.prepare(`UPDATE messages SET status='failed', error=?, updated_at=? WHERE id=?`)
      .bind(text.slice(0, 500), nowISO(), p.message_id).run();
    throw new Error(`wa_${res.status}:${text.slice(0,200)}`);
  }
  const data = await res.json() as { messages?: Array<{ id: string }> };
  const wamid = data.messages?.[0]?.id ?? '';

  await env.DB.prepare(
    `UPDATE messages SET status='sent', provider_msg_id=?, sent_at=?, updated_at=? WHERE id=?`,
  ).bind(wamid, nowISO(), nowISO(), p.message_id).run();
  await env.DB.prepare(`UPDATE agent_actions SET status='sent', updated_at=? WHERE result_ref=?`)
    .bind(nowISO(), p.message_id).run();
  return { ok: true, provider_msg_id: wamid };
}

// ─── Inbound ────────────────────────────────────────────────────────────────

interface WaWebhookEntry {
  id: string;
  changes?: Array<{
    value: {
      metadata?: { display_phone_number?: string; phone_number_id?: string };
      messages?: Array<{
        from: string; id: string; timestamp: string;
        text?: { body: string };
        button?: { text: string; payload: string };
        type: string;
      }>;
      statuses?: Array<{
        id: string; status: 'sent'|'delivered'|'read'|'failed';
        recipient_id: string; timestamp: string;
        errors?: Array<{ code: number; title: string }>;
      }>;
    };
    field: string;
  }>;
}

async function processInbound(p: InboundWaPayload, env: WaEnv): Promise<void> {
  const obj = await env.R2_EVIDENCE.get(p.raw_payload_uri);
  if (!obj) return;
  const raw = await obj.text();
  const body = JSON.parse(raw) as { entry?: WaWebhookEntry[] };

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value.metadata?.phone_number_id;
      // Resolve tenant by matching phone_number_id in api_credentials.metadata_json
      let tenantId = '';
      if (phoneNumberId) {
        const r = await env.DB.prepare(
          `SELECT tenant_id, id FROM api_credentials WHERE provider='whatsapp' AND is_active=1 AND metadata_json LIKE ? LIMIT 1`,
        ).bind(`%"${phoneNumberId}"%`).first<{ tenant_id: string; id: string }>();
        if (r) tenantId = r.tenant_id;
      }
      if (!tenantId) continue;

      // 1) Inbound user messages
      for (const m of change.value.messages ?? []) {
        const fromE164 = `+${m.from}`;
        const contact = await env.DB.prepare(
          `SELECT id FROM contacts WHERE tenant_id=? AND whatsapp_phone_e164=? LIMIT 1`,
        ).bind(tenantId, fromE164).first<{ id: string }>();
        if (!contact) continue;

        const msgId = uuidv4();
        const text = m.text?.body ?? m.button?.text ?? `[${m.type}]`;
        await env.DB.prepare(
          `INSERT INTO messages
             (id, tenant_id, contact_id, channel, direction, body_text, provider_msg_id, status, created_at, updated_at, sent_at)
           VALUES (?, ?, ?, 'whatsapp', 'inbound', ?, ?, 'received', ?, ?, ?)`,
        ).bind(msgId, tenantId, contact.id, text, m.id, nowISO(), nowISO(), nowISO()).run();

        // Trigger an agent run
        await env.Q_AGENT.send({
          id: uuidv4(), type: 'agent_job', tenant_id: tenantId, attempt: 1, enqueued_at: nowISO(),
          run_id: '',  // pre-created by agent worker on first read
          contact_id: contact.id, trigger_type: 'inbound_whatsapp',
          trigger_payload: { message_id: msgId, text },
        });
      }

      // 2) Delivery status updates
      for (const s of change.value.statuses ?? []) {
        const m = await env.DB.prepare(
          `SELECT id FROM messages WHERE provider_msg_id = ? AND tenant_id = ? LIMIT 1`,
        ).bind(s.id, tenantId).first<{ id: string }>();
        if (!m) continue;
        const newStatus = s.status === 'sent' ? 'sent'
                        : s.status === 'delivered' ? 'delivered'
                        : s.status === 'read' ? 'delivered'  // map read to delivered for status field
                        : 'failed';
        await env.DB.prepare(`UPDATE messages SET status=?, updated_at=? WHERE id=?`)
          .bind(newStatus, nowISO(), m.id).run();
        if (s.status === 'read') {
          await env.DB.prepare(
            `INSERT INTO message_events (id, message_id, event_type, count, occurred_at) VALUES (?, ?, 'read', 1, ?)`,
          ).bind(uuidv4(), m.id, nowISO()).run();
        }
      }
    }
  }
}
