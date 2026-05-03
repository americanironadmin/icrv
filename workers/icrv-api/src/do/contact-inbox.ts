// workers/icrv-api/src/do/contact-inbox.ts
// One DO per (tenant_id, contact_id). Serializes inbound event handling so
// that out-of-order webhook deliveries get re-ordered by occurred_at and
// processed sequentially. State is small — last 50 events.

interface InboxEvent {
  id: string;
  source: 'gmail' | 'whatsapp' | 'ringcentral' | 'elevenlabs';
  kind: string;            // e.g. 'message_received', 'call_ended'
  occurred_at: string;
  payload: Record<string, unknown>;
}

interface PersistedState {
  tenant_id: string;
  contact_id: string;
  events: InboxEvent[];          // most-recent 50, chronological
  total_events: number;
}

const STORAGE_KEY = 'inbox_state';
const WINDOW = 50;

export class ContactInboxDO {
  private state: DurableObjectState;
  private mem: PersistedState | null = null;

  constructor(state: DurableObjectState) { this.state = state; }

  private async load(tenantId?: string, contactId?: string): Promise<PersistedState> {
    if (this.mem) return this.mem;
    const stored = await this.state.storage.get<PersistedState>(STORAGE_KEY);
    if (stored) { this.mem = stored; return stored; }
    const fresh: PersistedState = {
      tenant_id: tenantId ?? '', contact_id: contactId ?? '',
      events: [], total_events: 0,
    };
    this.mem = fresh;
    await this.state.storage.put(STORAGE_KEY, fresh);
    return fresh;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/event' && req.method === 'POST') {
      const body = await req.json() as { tenant_id: string; contact_id: string; event: InboxEvent };
      const s = await this.load(body.tenant_id, body.contact_id);
      // Insert maintaining chronological order
      const idx = s.events.findIndex(e => e.occurred_at > body.event.occurred_at);
      if (idx === -1) s.events.push(body.event);
      else s.events.splice(idx, 0, body.event);
      while (s.events.length > WINDOW) s.events.shift();
      s.total_events += 1;
      await this.state.storage.put(STORAGE_KEY, s);
      return Response.json({ ok: true, total: s.total_events });
    }
    if (url.pathname === '/state' && req.method === 'GET') {
      const s = await this.load();
      return Response.json(s);
    }
    return new Response('not_found', { status: 404 });
  }
}
