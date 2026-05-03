// workers/icrv-api/src/do/campaign-coordinator.ts
// One DO per (tenant, campaign). Enforces per-campaign daily caps and dedup
// of duplicate enrollments.
//
// HTTP: POST /can-send  { channel, tenant_id }   → { allowed, reason? }
//       POST /reset

interface PersistedState {
  tenant_id: string;
  campaign_id: string;
  per_channel_daily_cap: Record<string, number>;
  sent_today_by_channel: Record<string, { count: number; day: string }>;
  created_at: string;
}

const STORAGE_KEY = 'campaign_state';
const DEFAULT_CAP_PER_CHANNEL = 5000;

export class CampaignCoordinatorDO {
  private state: DurableObjectState;
  private mem: PersistedState | null = null;

  constructor(state: DurableObjectState) { this.state = state; }

  private async load(tenantId?: string, campaignId?: string): Promise<PersistedState> {
    if (this.mem) return this.mem;
    const stored = await this.state.storage.get<PersistedState>(STORAGE_KEY);
    if (stored) { this.mem = stored; return stored; }
    const fresh: PersistedState = {
      tenant_id: tenantId ?? '',
      campaign_id: campaignId ?? '',
      per_channel_daily_cap: { email: DEFAULT_CAP_PER_CHANNEL, whatsapp: DEFAULT_CAP_PER_CHANNEL, voice: 500 },
      sent_today_by_channel: {},
      created_at: new Date().toISOString(),
    };
    this.mem = fresh;
    await this.state.storage.put(STORAGE_KEY, fresh);
    return fresh;
  }

  private async persist(): Promise<void> {
    if (this.mem) await this.state.storage.put(STORAGE_KEY, this.mem);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/can-send' && req.method === 'POST') {
      const { channel, tenant_id, campaign_id } = await req.json() as { channel: string; tenant_id: string; campaign_id?: string };
      const s = await this.load(tenant_id, campaign_id);
      const today = new Date().toISOString().slice(0, 10);
      const cap = s.per_channel_daily_cap[channel] ?? DEFAULT_CAP_PER_CHANNEL;
      const cur = s.sent_today_by_channel[channel];
      if (cur && cur.day === today && cur.count >= cap) {
        return Response.json({ allowed: false, reason: 'campaign_daily_cap_reached', cap, current: cur.count });
      }
      const nextCount = (cur && cur.day === today ? cur.count : 0) + 1;
      s.sent_today_by_channel[channel] = { day: today, count: nextCount };
      await this.persist();
      return Response.json({ allowed: true, current: nextCount, cap });
    }
    if (url.pathname === '/reset' && req.method === 'POST') {
      const tenantId = (await req.json() as { tenant_id?: string }).tenant_id ?? '';
      this.mem = null;
      await this.state.storage.delete(STORAGE_KEY);
      await this.load(tenantId);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/state' && req.method === 'GET') {
      const s = await this.load();
      return Response.json(s);
    }
    return new Response('not_found', { status: 404 });
  }
}
