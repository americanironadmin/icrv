// workers/icrv-cron/src/index.ts
// Scheduled worker — 5 cron specs
import type { BaseEnv } from '@icrv/shared/types';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import { RingCentralClient } from '@icrv/shared/ring-central-client';
import { calculateLeadScore } from '@icrv/shared/scoring';

export interface CronEnv extends BaseEnv {
  HOOKS_BASE_URL: string;   // e.g. https://hooks.icrv.app
  RC_CREDENTIAL_IDS: string; // comma-separated list of RC credential IDs to renew
  // ── Inherited from VoiceEnv shape so RingCentralClient.fromCredential(env)
  //    typechecks. The cron itself does not invoke the LLM proxy, but the
  //    RingCentral helper takes the full VoiceEnv signature.
  ANTHROPIC_API_KEY:    string;
  VOICE_LLM_MODEL:      string;
  VOICE_LLM_MAX_TOKENS: string;
  // ── D1 backup (Cloudflare D1 export API → R2_EXPORTS)
  CF_API_TOKEN:   string;   // secret; scopes: D1 Edit + R2 Edit
  CF_ACCOUNT_ID:  string;   // var
  D1_DATABASE_ID: string;   // var
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 1: Campaign tick — every minute (* * * * *)
// Finds due campaign_enrollments, checks CampaignCoordinatorDO, enqueues agent jobs
// ─────────────────────────────────────────────────────────────────────────────

async function runCampaignTick(env: CronEnv): Promise<void> {
  // Find enrollments that are active and due for their next step
  const due = await env.DB.prepare(
    `SELECT ce.id as enrollment_id, ce.tenant_id, ce.contact_id, ce.campaign_id,
            ce.current_step_index, cs.id as step_id, cs.channel, cs.template_id,
            cs.credential_id, cs.delay_hours
     FROM campaign_enrollments ce
     JOIN campaign_steps cs ON cs.campaign_id = ce.campaign_id
       AND cs.step_index = ce.current_step_index
     JOIN campaigns c ON c.id = ce.campaign_id
     WHERE ce.status = 'active'
       AND c.status = 'active'
       AND datetime(ce.next_step_at) <= datetime('now')
     LIMIT 500`,
  ).all<{
    enrollment_id: string; tenant_id: string; contact_id: string;
    campaign_id: string; current_step_index: number; step_id: string;
    channel: string; template_id: string; credential_id: string; delay_hours: number;
  }>();

  if (!due.results.length) return;

  for (const row of due.results) {
    // Check CampaignCoordinatorDO daily limit
    const doId = env.CAMPAIGN_DO.idFromName(`${row.tenant_id}:${row.campaign_id}`);
    const stub = env.CAMPAIGN_DO.get(doId);
    const canSendResp = await stub.fetch('http://do/can-send', {
      method: 'POST',
      body: JSON.stringify({ channel: row.channel, tenant_id: row.tenant_id }),
    });
    const { allowed } = await canSendResp.json() as { allowed: boolean };

    if (!allowed) {
      // Will be retried next tick
      continue;
    }

    const runId = uuidv4();
    const now = nowISO();

    // Pre-create agent_run record
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agent_runs
         (id, tenant_id, contact_id, campaign_id, trigger_type, trigger_payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'campaign_step', ?, 'queued', ?, ?)`,
    ).bind(
      runId, row.tenant_id, row.contact_id, row.campaign_id,
      JSON.stringify({
        enrollment_id: row.enrollment_id,
        step_id: row.step_id,
        step_index: row.current_step_index,
        channel: row.channel,
        template_id: row.template_id,
        credential_id: row.credential_id,
      }),
      now, now,
    ).run();

    // Advance enrollment to next step
    const nextStepResult = await env.DB.prepare(
      `SELECT id FROM campaign_steps
       WHERE campaign_id=? AND step_index=?`,
    ).bind(row.campaign_id, row.current_step_index + 1).first<{ id: string }>();

    if (nextStepResult) {
      // More steps remain — advance
      await env.DB.prepare(
        `UPDATE campaign_enrollments
         SET current_step_index = current_step_index + 1,
             next_step_at = datetime('now', '+' || ? || ' hours'),
             updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(row.delay_hours, row.enrollment_id).run();
    } else {
      // Last step — complete enrollment
      await env.DB.prepare(
        `UPDATE campaign_enrollments
         SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(row.enrollment_id).run();
    }

    // Enqueue agent job
    await env.Q_AGENT.send({
      id: uuidv4(),
      tenant_id: row.tenant_id,
      attempt: 1,
      enqueued_at: now,
      type: 'agent_job',
      run_id: runId,
      contact_id: row.contact_id,
      campaign_id: row.campaign_id,
      trigger_type: 'campaign_step',
      trigger_payload: {
        enrollment_id: row.enrollment_id,
        step_id: row.step_id,
        step_index: row.current_step_index,
        channel: row.channel,
        template_id: row.template_id,
        credential_id: row.credential_id,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 2: Gmail watch renewal + RingCentral subscription renewal (*/5 * * * *)
// Gmail watches expire after 7 days; RC subscriptions expire after 7 days
// ─────────────────────────────────────────────────────────────────────────────

async function runRenewalCheck(env: CronEnv): Promise<void> {
  // Gmail: find credentials whose gmail_watch_expires_at is within next 24 hours
  const gmailCreds = await env.DB.prepare(
    `SELECT id FROM api_credentials
     WHERE provider = 'gmail' AND is_active = 1
       AND (gmail_watch_expires_at IS NULL
            OR datetime(gmail_watch_expires_at) < datetime('now', '+24 hours'))`,
  ).all<{ id: string }>();

  for (const cred of gmailCreds.results) {
    try {
      // Call the hooks worker to renew via Gmail watch API
      // The actual Gmail watch.renew is done server-side by hitting the Gmail API
      // using the credential's OAuth token (fetched via OAuthRotatorDO)
      const doId = env.OAUTH_DO.idFromName(cred.id);
      const stub = env.OAUTH_DO.get(doId);
      const tokenResp = await stub.fetch('http://do/token');
      if (!tokenResp.ok) continue;

      const { access_token } = await tokenResp.json() as { access_token: string };

      // Resolve the GCP project hosting the gmail-push Pub/Sub topic.
      // Stored once at provisioning time in KV_CONFIG under key 'gcp_project_id'.
      const gcpProjectId = await env.KV_CONFIG.get('gcp_project_id');
      if (!gcpProjectId) {
        console.error('[cron] gcp_project_id missing from KV_CONFIG; skipping Gmail watch renewal');
        continue;
      }

      // Renew Gmail push notification watch
      const watchRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          topicName: `projects/${gcpProjectId}/topics/gmail-push`,
          labelIds: ['INBOX'],
        }),
      });

      if (watchRes.ok) {
        const watchData = await watchRes.json() as { expiration: string };
        // Store new expiry (epoch ms → ISO)
        const expiresAt = new Date(parseInt(watchData.expiration, 10)).toISOString();
        await env.DB.prepare(
          `UPDATE api_credentials SET gmail_watch_expires_at=?, updated_at=datetime('now') WHERE id=?`,
        ).bind(expiresAt, cred.id).run();
      }
    } catch (err) {
      console.error(`[cron] Gmail watch renewal failed for ${cred.id}:`, err);
    }
  }

  // RingCentral: find subscriptions expiring within next 24 hours
  const rcSubKeys = await env.KV_CONFIG.list({ prefix: 'rc:subscription:' });

  for (const key of rcSubKeys.keys) {
    try {
      const subMeta = await env.KV_CONFIG.get(key.name);
      if (!subMeta) continue;

      const { subscription_id, credential_id, expires_at } = JSON.parse(subMeta) as {
        subscription_id: string; credential_id: string; expires_at: string;
      };

      const expiresAt = new Date(expires_at).getTime();
      if (expiresAt > Date.now() + 24 * 3600_000) continue; // not expiring soon

      const rcClient = await RingCentralClient.fromCredential(credential_id, env);
      await rcClient.renewSubscription(subscription_id);

      // Update stored expiry
      const newExpiry = new Date(Date.now() + 7 * 86400_000).toISOString();
      await env.KV_CONFIG.put(key.name, JSON.stringify({
        subscription_id, credential_id, expires_at: newExpiry,
      }));
    } catch (err) {
      console.error(`[cron] RC subscription renewal failed for ${key.name}:`, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 3: Rate-limit window roll + KV cleanup (0 * * * *)
// Flushes stale KV_RATE counters so sliding window resets properly
// ─────────────────────────────────────────────────────────────────────────────

async function runRateWindowRoll(env: CronEnv): Promise<void> {
  // KV_RATE keys are set with expirationTtl so they self-expire.
  // This cron additionally flushes KV_TRACK aggregates to D1.

  const trackKeys = await env.KV_TRACK.list({ prefix: 'open:' });

  const batch: Promise<unknown>[] = [];

  for (const key of trackKeys.keys) {
    const val = await env.KV_TRACK.get(key.name);
    if (!val) continue;

    // key format: open:{message_id}  or  click:{message_id}
    const [type, messageId] = key.name.split(':');
    const count = parseInt(val, 10);

    if (count > 0) {
      const eventType = type === 'open' ? 'opened' : 'clicked';
      batch.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO message_events (id, message_id, event_type, count, occurred_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
        ).bind(uuidv4(), messageId, eventType, count).run(),
      );
    }

    batch.push(env.KV_TRACK.delete(key.name));
  }

  if (batch.length) await Promise.allSettled(batch);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 4: Nightly digest + 90-day retention purge (0 3 * * *)
// ─────────────────────────────────────────────────────────────────────────────

async function runNightlyMaintenance(env: CronEnv): Promise<void> {
  // Phase 4 — full lead-score recalculation for every active tenant.
  await runLeadScoringSweep(env);

  // Purge audit_logs > 90 days
  await env.DB.prepare(
    `DELETE FROM audit_logs WHERE created_at < datetime('now', '-90 days')`,
  ).run();

  // Purge message_events > 90 days (keep message records)
  await env.DB.prepare(
    `DELETE FROM message_events WHERE occurred_at < datetime('now', '-90 days')`,
  ).run();

  // Purge webhooks_received > 30 days
  await env.DB.prepare(
    `DELETE FROM webhooks_received WHERE received_at < datetime('now', '-30 days')`,
  ).run();

  // Purge completed agent_runs > 90 days
  await env.DB.prepare(
    `DELETE FROM agent_runs
     WHERE status IN ('completed','blocked_by_policy','failed')
       AND completed_at < datetime('now', '-90 days')`,
  ).run();

  // Nightly campaign digest: compute counts and update campaign stats cache in KV
  const campaigns = await env.DB.prepare(
    `SELECT c.id, c.tenant_id,
            COUNT(DISTINCT ce.contact_id) as enrolled,
            SUM(CASE WHEN ce.status='completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN m.status='sent' THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN me.event_type='opened' THEN 1 ELSE 0 END) as opens
     FROM campaigns c
     LEFT JOIN campaign_enrollments ce ON ce.campaign_id = c.id
     LEFT JOIN messages m ON m.campaign_id = c.id
     LEFT JOIN message_events me ON me.message_id = m.id
     WHERE c.status IN ('active','paused','completed')
       AND c.updated_at >= datetime('now', '-1 day')
     GROUP BY c.id`,
  ).all<{
    id: string; tenant_id: string; enrolled: number;
    completed: number; sent: number; opens: number;
  }>();

  for (const row of campaigns.results) {
    await env.KV_CONFIG.put(
      `stats:campaign:${row.id}`,
      JSON.stringify({ enrolled: row.enrolled, completed: row.completed, sent: row.sent, opens: row.opens, updated_at: nowISO() }),
      { expirationTtl: 7 * 86400 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 4b: Daily D1 backup → R2_EXPORTS (also runs on 0 3 * * *)
// Uses Cloudflare D1 export API (output_format=polling) → SQL dump → R2.
// Retention: handled by an R2 lifecycle rule on icrv-exports (manual setup).
// Failure surface: writes last_d1_backup_status to KV_TRACK for operator view.
// ─────────────────────────────────────────────────────────────────────────────

async function runD1Backup(env: CronEnv): Promise<void> {
  const { CF_API_TOKEN, CF_ACCOUNT_ID, D1_DATABASE_ID } = env;

  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !D1_DATABASE_ID) {
    console.error('[cron] D1 backup: missing CF_API_TOKEN/CF_ACCOUNT_ID/D1_DATABASE_ID');
    await env.KV_TRACK.put('last_d1_backup_status', JSON.stringify({
      ok: false, ts: nowISO(), reason: 'missing_config',
    }));
    return;
  }

  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const r2Key = `d1-backups/icrv-db-${dateKey}.sql`;
  const exportUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/export`;
  const headers = {
    Authorization: `Bearer ${CF_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  type ExportResponse = {
    success?: boolean;
    errors?: { code: number; message: string }[];
    result?: {
      at_bookmark?: string;
      status?: string;
      result?: { filename?: string; signed_url?: string };
      messages?: string[];
    };
  };

  try {
    let bookmark: string | undefined;
    let signedUrl: string | undefined;
    const start = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;

    for (let attempt = 0; attempt < 60; attempt++) {
      if (Date.now() - start > TIMEOUT_MS) {
        throw new Error('export polling timed out after 5min');
      }

      const body: Record<string, unknown> = { output_format: 'polling' };
      if (bookmark) body.current_bookmark = bookmark;

      const res = await fetch(exportUrl, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        throw new Error(`export call ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const payload = await res.json() as ExportResponse;
      if (!payload.success) {
        throw new Error(`export error: ${JSON.stringify(payload.errors ?? payload)}`);
      }

      const result = payload.result ?? {};
      signedUrl = result.result?.signed_url;
      if (signedUrl) break;

      if (result.at_bookmark) bookmark = result.at_bookmark;
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!signedUrl) throw new Error('export polling completed without a signed_url');

    const dumpRes = await fetch(signedUrl);
    if (!dumpRes.ok) throw new Error(`download dump ${dumpRes.status}`);
    const dumpBody = await dumpRes.arrayBuffer();
    if (dumpBody.byteLength === 0) throw new Error('downloaded dump is empty');

    await env.R2_EXPORTS.put(r2Key, dumpBody, {
      httpMetadata: { contentType: 'application/sql' },
      customMetadata: { 'export-date': dateKey, source: 'icrv-cron' },
    });

    console.log(`[cron] D1 backup OK: ${r2Key} (${dumpBody.byteLength} bytes)`);
    await env.KV_TRACK.put('last_d1_backup_status', JSON.stringify({
      ok: true, ts: nowISO(), key: r2Key, bytes: dumpBody.byteLength,
    }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[cron] D1 backup failed:', reason);
    await env.KV_TRACK.put('last_d1_backup_status', JSON.stringify({
      ok: false, ts: nowISO(), reason,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled handler dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: CronEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/admin/run-d1-backup' && req.method === 'POST') {
      const auth = req.headers.get('authorization') ?? '';
      if (!env.CF_API_TOKEN || auth !== `Bearer ${env.CF_API_TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      ctx.waitUntil(runD1Backup(env));
      return new Response(JSON.stringify({ ok: true, msg: 'backup started' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/admin/last-d1-backup-status') {
      const auth = req.headers.get('authorization') ?? '';
      if (!env.CF_API_TOKEN || auth !== `Bearer ${env.CF_API_TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      const status = await env.KV_TRACK.get('last_d1_backup_status');
      return new Response(status ?? '{"ok":null,"reason":"never_run"}', {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('icrv-cron — scheduled worker only', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    const { cron } = event;

    ctx.waitUntil(
      (async () => {
        try {
          if (cron === '* * * * *') {
            await runCampaignTick(env);
          } else if (cron === '*/5 * * * *') {
            await runRenewalCheck(env);
          } else if (cron === '0 * * * *') {
            await runRateWindowRoll(env);
          } else if (cron === '0 3 * * *') {
            await Promise.allSettled([
              runNightlyMaintenance(env),
              runD1Backup(env),
            ]);
          } else {
            console.warn(`[cron] unknown cron expression: ${cron}`);
          }
        } catch (err) {
          console.error(`[cron] error in ${cron}:`, err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<CronEnv>;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: nightly lead-score sweep
// ─────────────────────────────────────────────────────────────────────────────

async function runLeadScoringSweep(env: CronEnv): Promise<void> {
  const tenants = await env.DB.prepare(
    `SELECT id FROM tenants`,
  ).all<{ id: string }>();
  for (const t of tenants.results ?? []) {
    const contacts = await env.DB.prepare(
      `SELECT id, country_code, industry, tags_json FROM contacts WHERE tenant_id = ? LIMIT 5000`,
    ).bind(t.id).all<{ id: string; country_code: string | null; industry: string | null; tags_json: string | null }>();
    for (const c of contacts.results ?? []) {
      const trackRows = await env.DB.prepare(
        `SELECT type, COUNT(*) AS n FROM tracking_events
           WHERE tenant_id = ? AND contact_id = ?
           GROUP BY type`,
      ).bind(t.id, c.id).all<{ type: string; n: number }>();
      const trackMap: Record<string, number> = {};
      for (const r of trackRows.results ?? []) trackMap[r.type] = r.n;
      const repliesRow = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM message_events e
           JOIN messages m ON m.id = e.message_id
          WHERE m.tenant_id = ? AND m.contact_id = ? AND e.event_type = 'replied'`,
      ).bind(t.id, c.id).first<{ n: number }>();
      const recentRow = await env.DB.prepare(
        `SELECT MAX(occurred_at) AS last FROM tracking_events
           WHERE tenant_id = ? AND contact_id = ?`,
      ).bind(t.id, c.id).first<{ last: string | null }>();
      const lastTs = recentRow?.last ? new Date(recentRow.last).getTime() : 0;
      const recent = lastTs > 0 && Date.now() - lastTs < 7 * 24 * 60 * 60 * 1000;
      const tags: string[] = c.tags_json ? safeArr(c.tags_json) : [];

      const score = calculateLeadScore(
        {
          opens:  trackMap.open  ?? 0,
          clicks: trackMap.click ?? 0,
          replies: repliesRow?.n ?? 0,
          website_visits: 0, form_submissions: 0,
          last_activity_within_7d: recent,
        },
        { country: c.country_code ?? undefined, industry: c.industry ?? undefined },
        tags,
      );

      await env.DB.prepare(
        `INSERT INTO lead_scores
           (contact_id, tenant_id, score, category, engagement_score, demographic_score, behavioral_score, tag_score, last_calculated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET
           score=excluded.score, category=excluded.category,
           engagement_score=excluded.engagement_score,
           demographic_score=excluded.demographic_score,
           behavioral_score=excluded.behavioral_score,
           tag_score=excluded.tag_score,
           last_calculated=excluded.last_calculated`,
      ).bind(
        c.id, t.id, score.score, score.category,
        score.engagement, score.demographic, score.behavioral, score.tag,
        nowISO(),
      ).run();
    }
  }
}

function safeArr(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
}
