// workers/icrv-cron/src/index.ts
// Scheduled worker — 5 cron specs
import type { BaseEnv } from '@icrv/shared/types';
import { uuidv4, nowISO } from '@icrv/shared/crypto';
import { RingCentralClient } from '@icrv/shared/ring-central-client';

export interface CronEnv extends BaseEnv {
  HOOKS_BASE_URL: string;   // e.g. https://hooks.icrv.app
  RC_CREDENTIAL_IDS: string; // comma-separated list of RC credential IDs to renew
  // ── Inherited from VoiceEnv shape so RingCentralClient.fromCredential(env)
  //    typechecks. The cron itself does not invoke the LLM proxy, but the
  //    RingCentral helper takes the full VoiceEnv signature.
  ANTHROPIC_API_KEY:    string;
  VOICE_LLM_MODEL:      string;
  VOICE_LLM_MAX_TOKENS: string;
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
// Scheduled handler dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(): Promise<Response> {
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
            await runNightlyMaintenance(env);
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
