// workers/icrv-consumer/src/index.ts
// Catch-all consumer for queues whose owning workers don't consume directly.
// We split queue consumption across workers for blast-radius isolation:
//
//   icrv-email     consumes  icrv-email-out
//   icrv-whatsapp  consumes  icrv-wa-out, icrv-wa-in
//   icrv-voice     consumes  icrv-voice-postcall
//   icrv-agent     consumes  icrv-agent-jobs
//   icrv-consumer  consumes  icrv-email-in, icrv-retry, icrv-dlq
//
// This worker handles inbound email (Gmail history fetch + parse), the
// retry queue (re-enqueue after delay), and the DLQ (audit + alert).

import type {
  BaseEnv, InboundEmailPayload, RetryPayload, QueuePayload, ImportJobPayload,
} from '@icrv/shared/types';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import { isDuplicate } from '@icrv/shared/queue-helpers';
import { processImportJob } from './import-processor';

interface ConsumerEnv extends BaseEnv {
  GOOGLE_CLIENT_ID:     string;
  GOOGLE_CLIENT_SECRET: string;
}

export default {
  async fetch(_req: Request): Promise<Response> {
    return Response.json({ ok: true, service: 'icrv-consumer' });
  },

  async queue(batch: MessageBatch<InboundEmailPayload | RetryPayload | QueuePayload | ImportJobPayload>, env: ConsumerEnv): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body as InboundEmailPayload | RetryPayload | QueuePayload | ImportJobPayload;

        if (body.type === 'email_in') {
          if (await isDuplicate(env, body.id)) { msg.ack(); continue; }
          await processGmailPush(body as InboundEmailPayload, env);
          msg.ack();
          continue;
        }

        if (body.type === 'retry') {
          await processRetry(body as RetryPayload, env);
          msg.ack();
          continue;
        }

        if (body.type === 'import_job') {
          if (await isDuplicate(env, body.id)) { msg.ack(); continue; }
          await processImportJob(body as ImportJobPayload, env);
          msg.ack();
          continue;
        }

        // Anything that landed in DLQ — emit an audit row (the row was already
        // written by scheduleRetry/deadLetter in shared/queue-helpers).
        if (body.dlq_reason) {
          // Already audited; just ack.
          msg.ack();
          continue;
        }

        // Unknown — ack to avoid infinite redelivery
        console.warn('[icrv-consumer] unknown payload', body);
        msg.ack();
      } catch (err) {
        // If THIS worker explodes, retry the message via the queue's own retry semantics
        console.error('[icrv-consumer]', err);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<ConsumerEnv, InboundEmailPayload | RetryPayload | QueuePayload | ImportJobPayload>;

// ─── Inbound Gmail processing ───────────────────────────────────────────────

async function processGmailPush(p: InboundEmailPayload, env: ConsumerEnv): Promise<void> {
  if (!p.oauth_token_id) return;

  const token = await env.DB.prepare(
    `SELECT id, tenant_id, email FROM oauth_tokens WHERE id = ? AND is_active = 1`,
  ).bind(p.oauth_token_id).first<{ id: string; tenant_id: string; email?: string|null }>();
  if (!token) return;

  const stub = env.OAUTH_DO.get(env.OAUTH_DO.idFromName(p.oauth_token_id));
  const tokRes = await stub.fetch('http://do/token', { headers: { 'x-oauth-token-id': p.oauth_token_id } });
  if (!tokRes.ok) return;
  const { access_token } = await tokRes.json() as { access_token: string };

  // Pull recent inbox messages (history-based delta is more accurate but
  // requires storing previous historyId; we do that below).
  const lastHistoryKey = `gmail_last_history:${p.oauth_token_id}`;
  const lastHistory    = await env.KV_CONFIG.get(lastHistoryKey);

  let messageIds: string[] = [];
  if (lastHistory && p.history_id && lastHistory !== p.history_id) {
    const histRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(lastHistory)}&historyTypes=messageAdded`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    if (histRes.ok) {
      const hd = await histRes.json() as { history?: Array<{ messages?: Array<{ id: string }> }> };
      for (const h of hd.history ?? []) for (const m of h.messages ?? []) messageIds.push(m.id);
    }
  } else {
    // First pass — pull the most recent 5 inbox messages
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=5`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    if (listRes.ok) {
      const ld = await listRes.json() as { messages?: Array<{ id: string }> };
      messageIds = (ld.messages ?? []).map(m => m.id);
    }
  }

  for (const gid of messageIds) {
    // Skip already-stored
    const existing = await env.DB.prepare(
      `SELECT id FROM messages WHERE provider_msg_id = ? AND tenant_id = ? LIMIT 1`,
    ).bind(gid, token.tenant_id).first<{ id: string }>();
    if (existing) continue;

    const detailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gid}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=References&metadataHeaders=In-Reply-To`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    if (!detailRes.ok) continue;
    const det = await detailRes.json() as {
      id: string; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> };
      labelIds?: string[];
    };
    if (!det.labelIds?.includes('INBOX')) continue;

    const headers = det.payload?.headers ?? [];
    const fromHeader = headers.find(h => h.name === 'From')?.value ?? '';
    const subject    = headers.find(h => h.name === 'Subject')?.value ?? '';
    // Extract email from "Name <addr@x>" or bare addr
    const fromAddr = (fromHeader.match(/<([^>]+)>/)?.[1] ?? fromHeader).trim().toLowerCase();

    const contact = await env.DB.prepare(
      `SELECT id FROM contacts WHERE tenant_id = ? AND email = ? LIMIT 1`,
    ).bind(token.tenant_id, fromAddr).first<{ id: string }>();
    if (!contact) continue;

    const newId = uuidv4();
    await env.DB.prepare(
      `INSERT INTO messages
         (id, tenant_id, contact_id, channel, direction, subject, body_text, provider_msg_id, status, created_at, updated_at, sent_at)
       VALUES (?, ?, ?, 'email', 'inbound', ?, ?, ?, 'received', ?, ?, ?)`,
    ).bind(newId, token.tenant_id, contact.id, subject, det.snippet ?? '', gid, nowISO(), nowISO(), nowISO()).run();

    // If the inbound is a reply to a tracked outbound, mark message_events 'replied'
    const refId = (headers.find(h => h.name === 'In-Reply-To')?.value ?? '').replace(/[<>]/g, '');
    if (refId) {
      const orig = await env.DB.prepare(
        `SELECT id FROM messages WHERE provider_msg_id = ? AND direction='outbound' LIMIT 1`,
      ).bind(refId).first<{ id: string }>();
      if (orig) {
        await env.DB.prepare(
          `INSERT INTO message_events (id, message_id, event_type, count, occurred_at) VALUES (?, ?, 'replied', 1, ?)`,
        ).bind(uuidv4(), orig.id, nowISO()).run();
      }
    }

    // Trigger an agent run so it can react to the reply
    await env.Q_AGENT.send({
      id: uuidv4(), type: 'agent_job', tenant_id: token.tenant_id, attempt: 1,
      enqueued_at: nowISO(), run_id: '',
      contact_id: contact.id, trigger_type: 'inbound_email',
      trigger_payload: { message_id: newId, subject },
    });
  }

  if (p.history_id) await env.KV_CONFIG.put(lastHistoryKey, p.history_id, { expirationTtl: 30 * 86400 });
}

// ─── Retry processing ──────────────────────────────────────────────────────

async function processRetry(p: RetryPayload, env: ConsumerEnv): Promise<void> {
  const dueAt = new Date(p.next_attempt_at).getTime();
  if (dueAt > Date.now()) {
    // Re-queue with the remaining delay
    const delaySec = Math.max(1, Math.floor((dueAt - Date.now()) / 1000));
    await env.Q_RETRY.send(p, { delaySeconds: delaySec });
    return;
  }
  // Re-enqueue back to the original queue
  switch (p.original_queue) {
    case 'icrv-email-out':      await env.Q_EMAIL_OUT.send(p.original_payload as never); break;
    case 'icrv-wa-out':         await env.Q_WA_OUT.send(p.original_payload as never);    break;
    case 'icrv-wa-in':          await env.Q_WA_IN.send(p.original_payload as never);     break;
    case 'icrv-voice-postcall': await env.Q_VOICE_POSTCALL.send(p.original_payload as never); break;
    case 'icrv-agent-jobs':     await env.Q_AGENT.send(p.original_payload as never);     break;
    default:
      await env.Q_DLQ.send({ ...p.original_payload, dlq_reason: `unknown_original_queue:${p.original_queue}`, dlq_at: nowISO() });
  }
}
