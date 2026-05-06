// workers/icrv-api/src/routes/settings.ts
// Phase 2 — tenant settings sub-routed by section.
// Sections (JSON blobs in tenant_settings):
//   workspace        — name, website, timezone, logo_url
//   compliance       — physical_address (CAN-SPAM), unsubscribe_text
//   sending          — daily_limit, throttle_per_sec, warmup_enabled
//   tracking         — open_tracking, click_tracking, custom_domain, utm_*
//   authentication   — domain, dkim_selector, dkim_public_key (cached)
//   personalization  — variables[]
//   bounce           — hard_bounce_threshold, soft_bounce_retries, autounsub_on_complaint
//   api_webhooks     — api_key_hash, webhook_subscriptions[]

import { Hono } from 'hono';
import type { HonoCtx } from '../env';
import { nowISO } from '@icrv/shared/crypto';

type Section =
  | 'workspace'
  | 'compliance'
  | 'sending'
  | 'tracking'
  | 'authentication'
  | 'personalization'
  | 'bounce'
  | 'api_webhooks';

const COLUMN: Record<Section, string> = {
  workspace:       'workspace_json',
  compliance:      'compliance_json',
  sending:         'sending_json',
  tracking:        'tracking_json',
  authentication:  'authentication_json',
  personalization: 'personalization_json',
  bounce:          'bounce_json',
  api_webhooks:    'api_webhooks_json',
};

const SECTIONS = Object.keys(COLUMN) as Section[];

const DEFAULTS: Record<Section, Record<string, unknown>> = {
  workspace: {
    company_name: 'American Iron LLC',
    website:      'https://americaniron1.com',
    timezone:     'America/New_York',
  },
  compliance: {
    physical_address: {
      street: '__PLACEHOLDER__',
      city:   '',
      state:  '',
      zip:    '',
      country: 'US',
    },
    unsubscribe_text: 'To stop receiving these emails, unsubscribe here: {{unsubscribe_url}}',
  },
  sending: {
    daily_limit:        500,
    throttle_per_sec:   5,
    warmup_enabled:     false,
    custom_from_domain: '',
  },
  tracking: {
    open_tracking:    true,
    click_tracking:   true,
    custom_domain:    '',
    utm_prefix:       'icrv',
    utm_medium:       'email',
    utm_campaign_prefix: '',
    google_analytics: false,
  },
  authentication: {
    domain:        '',
    dkim_selector: 'icrv',
    dkim_public_key: '',
  },
  personalization: { variables: [] },
  bounce: {
    hard_bounce_threshold:   3,
    soft_bounce_retries:     3,
    autounsub_on_complaint:  true,
    bounce_notification_email: '',
  },
  api_webhooks: {
    api_key_hash: null,
    api_key_last4: null,
    api_key_created_at: null,
    webhook_subscriptions: [],
  },
};

export function createSettingsRouter(): Hono<HonoCtx> {
  const app = new Hono<HonoCtx>();

  app.get('/', async (c) => {
    const tenantId = c.get('tenant_id');
    const merged = await loadAllSections(c.env.DB, tenantId);
    return c.json(merged);
  });

  app.get('/:section', async (c) => {
    const section = c.req.param('section') as Section;
    if (!SECTIONS.includes(section)) return c.json({ error: 'unknown_section' }, 404);
    const tenantId = c.get('tenant_id');
    const data = await loadSection(c.env.DB, tenantId, section);
    return c.json(data);
  });

  app.put('/:section', async (c) => {
    if (c.get('user_role') === 'viewer') return c.json({ error: 'forbidden' }, 403);
    const section = c.req.param('section') as Section;
    if (!SECTIONS.includes(section)) return c.json({ error: 'unknown_section' }, 404);
    const tenantId = c.get('tenant_id');
    const incoming = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!incoming || typeof incoming !== 'object') return c.json({ error: 'invalid_body' }, 400);
    // Merge with current to preserve fields the client did not send.
    const current = await loadSection(c.env.DB, tenantId, section);
    const merged = { ...current, ...incoming };
    const json = JSON.stringify(merged);
    const col = COLUMN[section];
    await c.env.DB.prepare(
      `INSERT INTO tenant_settings (tenant_id, ${col}, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET ${col}=excluded.${col}, updated_at=excluded.updated_at`,
    ).bind(tenantId, json, nowISO()).run();
    return c.json(merged);
  });

  return app;
}

export async function loadSection(
  db: D1Database, tenantId: string, section: Section,
): Promise<Record<string, unknown>> {
  const col = COLUMN[section];
  const row = await db.prepare(
    `SELECT ${col} AS section_json FROM tenant_settings WHERE tenant_id=?`,
  ).bind(tenantId).first<{ section_json: string }>();
  const persisted = row?.section_json ? safeParse(row.section_json) : {};
  return { ...DEFAULTS[section], ...persisted };
}

export async function loadAllSections(
  db: D1Database, tenantId: string,
): Promise<Record<Section, Record<string, unknown>>> {
  const row = await db.prepare(
    `SELECT workspace_json, compliance_json, sending_json, tracking_json,
            authentication_json, personalization_json, bounce_json, api_webhooks_json
       FROM tenant_settings WHERE tenant_id=?`,
  ).bind(tenantId).first<Record<string, string>>();
  const out = {} as Record<Section, Record<string, unknown>>;
  for (const s of SECTIONS) {
    const col = COLUMN[s];
    const persisted = row?.[col] ? safeParse(row[col]) : {};
    out[s] = { ...DEFAULTS[s], ...persisted };
  }
  return out;
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
