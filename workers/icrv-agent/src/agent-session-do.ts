// workers/icrv-agent/src/agent-session-do.ts
// AgentSessionDO — one Durable Object per (tenant_id, contact_id) pair.
//
// Responsibilities:
//   - Maintain a rolling in-memory window of the last N conversation events
//     (messages sent/received, calls, agent decisions) without re-querying D1
//   - Track unanswered_sequence (consecutive outbound with no inbound reply)
//   - Serve context snapshots to the agent worker synchronously (< 1 ms)
//   - Accept event pushes from hooks and consumer workers
//   - Persist state to DO storage on every mutation for durability
//
// Naming convention:  AgentSessionDO.idFromName(`${tenantId}:${contactId}`)
//
// HTTP API (internal — called via service binding from icrv-agent):
//
//   POST /event       Push a new event into the rolling window
//   GET  /snapshot    Get current context snapshot for LLM prompt
//   POST /reset       Clear session (e.g. contact re-enrolled)

import { nowISO } from '@icrv/shared/crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SessionEventType =
  | 'message_sent'
  | 'message_received'
  | 'message_opened'
  | 'message_clicked'
  | 'call_placed'
  | 'call_ended'
  | 'call_voicemail'
  | 'agent_decision'
  | 'tag_added'
  | 'enrollment_started'
  | 'enrollment_stopped'
  | 'human_escalation';

export interface SessionEvent {
  event_type:   SessionEventType;
  channel?:     string;
  direction?:   'inbound' | 'outbound';
  summary:      string;  // ≤ 300 chars — used in LLM prompt
  metadata?:    Record<string, unknown>;
  occurred_at:  string;  // ISO
}

export interface SessionSnapshot {
  tenant_id:           string;
  contact_id:          string;
  events:              SessionEvent[];        // last WINDOW_SIZE events, chronological
  unanswered_sequence: number;               // consecutive outbound without inbound reply
  last_inbound_at?:    string;               // ISO of last inbound message
  last_outbound_at?:   string;              // ISO of last outbound message
  last_agent_run_at?:  string;              // ISO of last agent decision
  total_events:        number;              // lifetime counter
  session_started_at:  string;             // ISO
  snapshot_at:         string;             // ISO of when this snapshot was generated
}

interface PersistedState {
  tenant_id:           string;
  contact_id:          string;
  events:              SessionEvent[];
  unanswered_sequence: number;
  last_inbound_at?:    string;
  last_outbound_at?:   string;
  last_agent_run_at?:  string;
  total_events:        number;
  session_started_at:  string;
}

const WINDOW_SIZE        = 20; // keep last N events in memory / storage
const STORAGE_KEY        = 'session_state';

// ─────────────────────────────────────────────────────────────────────────────
// Durable Object class
// ─────────────────────────────────────────────────────────────────────────────

export class AgentSessionDO {
  private state:   DurableObjectState;
  private session: PersistedState | null = null; // lazy-loaded

  constructor(state: DurableObjectState) {
    this.state = state;
    // Hibernate storage is not used — we keep the full window in memory
    // and write through to DO storage on every mutation.
  }

  // ─── Lazy init ────────────────────────────────────────────────────────────

  private async loadOrInit(tenantId: string, contactId: string): Promise<PersistedState> {
    if (this.session) return this.session;

    const stored = await this.state.storage.get<PersistedState>(STORAGE_KEY);
    if (stored) {
      this.session = stored;
      return stored;
    }

    // First access — initialise
    const fresh: PersistedState = {
      tenant_id:           tenantId,
      contact_id:          contactId,
      events:              [],
      unanswered_sequence: 0,
      total_events:        0,
      session_started_at:  nowISO(),
    };
    this.session = fresh;
    await this.state.storage.put(STORAGE_KEY, fresh);
    return fresh;
  }

  private async persist(): Promise<void> {
    if (!this.session) return;
    await this.state.storage.put(STORAGE_KEY, this.session);
  }

  // ─── HTTP handler ─────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {

      case '/event': {
        if (request.method !== 'POST') {
          return new Response('method_not_allowed', { status: 405 });
        }
        const body = await request.json() as {
          tenant_id:  string;
          contact_id: string;
          event:      SessionEvent;
        };

        await this.pushEvent(body.tenant_id, body.contact_id, body.event);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      case '/snapshot': {
        if (request.method !== 'GET') {
          return new Response('method_not_allowed', { status: 405 });
        }
        const { searchParams } = url;
        const tenantId  = searchParams.get('tenant_id')  ?? '';
        const contactId = searchParams.get('contact_id') ?? '';

        const snapshot = await this.getSnapshot(tenantId, contactId);
        return new Response(JSON.stringify(snapshot), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      case '/reset': {
        if (request.method !== 'POST') {
          return new Response('method_not_allowed', { status: 405 });
        }
        const body = await request.json() as { tenant_id: string; contact_id: string };
        await this.resetSession(body.tenant_id, body.contact_id);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      default:
        return new Response('not_found', { status: 404 });
    }
  }

  // ─── Domain logic ─────────────────────────────────────────────────────────

  private async pushEvent(
    tenantId:  string,
    contactId: string,
    event:     SessionEvent,
  ): Promise<void> {
    const s = await this.loadOrInit(tenantId, contactId);

    // Truncate summary to 300 chars
    event.summary = event.summary.slice(0, 300);

    // Update sliding window
    s.events.push(event);
    if (s.events.length > WINDOW_SIZE) {
      s.events.shift(); // drop oldest
    }
    s.total_events += 1;

    // Update directional timestamps and unanswered sequence counter
    if (event.direction === 'outbound') {
      s.last_outbound_at = event.occurred_at;
      s.unanswered_sequence += 1;
    } else if (event.direction === 'inbound') {
      s.last_inbound_at = event.occurred_at;
      s.unanswered_sequence = 0; // reset on any inbound message
    }

    if (event.event_type === 'agent_decision') {
      s.last_agent_run_at = event.occurred_at;
    }

    await this.persist();
  }

  private async getSnapshot(tenantId: string, contactId: string): Promise<SessionSnapshot> {
    const s = await this.loadOrInit(tenantId, contactId);
    return {
      tenant_id:           s.tenant_id,
      contact_id:          s.contact_id,
      events:              [...s.events], // defensive copy
      unanswered_sequence: s.unanswered_sequence,
      last_inbound_at:     s.last_inbound_at,
      last_outbound_at:    s.last_outbound_at,
      last_agent_run_at:   s.last_agent_run_at,
      total_events:        s.total_events,
      session_started_at:  s.session_started_at,
      snapshot_at:         nowISO(),
    };
  }

  private async resetSession(tenantId: string, contactId: string): Promise<void> {
    await this.loadOrInit(tenantId, contactId); // ensure initialised
    const fresh: PersistedState = {
      tenant_id:           tenantId,
      contact_id:          contactId,
      events:              [],
      unanswered_sequence: 0,
      total_events:        0,
      session_started_at:  nowISO(),
    };
    this.session = fresh;
    await this.persist();
  }
}
