// src/api/agent.ts
// Agent control-plane API
//
// SOURCE OF TRUTH: workers/icrv-agent/src/control-panel.ts (present in project)
// MOUNT PATH (confirmed line 2 of control-panel.ts): /v1/agent-controls
//
// VERIFIED routes (read directly from control-panel.ts):
//   GET    /v1/agent-controls                           list all controls for tenant
//   PUT    /v1/agent-controls/:scope                    upsert scope controls
//   DELETE /v1/agent-controls/:scope                    delete scope controls
//   GET    /v1/agent-controls/runs/pending              pending human-review runs
//   GET    /v1/agent-controls/runs                      run history
//   POST   /v1/agent-controls/runs/:runId/approve       approve pending run
//   POST   /v1/agent-controls/runs/:runId/reject        reject pending run
//   PATCH  /v1/agent-controls/runs/:runId/edit          edit run decision
//   POST   /v1/agent-controls/actions/:actionId/revoke  revoke action
//   POST   /v1/agent-controls/kill-switch               activate kill switch
//   DELETE /v1/agent-controls/kill-switch               deactivate kill switch
//
// UNVERIFIED routes (icrv-api main router not in project files — flag for backend owner):
//   /v1/contacts, /v1/campaigns, /v1/logs, /v1/calls, /v1/dashboard, /v1/auth/me

import { get, post, put, del } from './client'
import api from './client'
import type { AxiosResponse } from 'axios'

// ─── Scope ────────────────────────────────────────────────────────────────────

export type ControlScope = 'global' | 'tenant' | 'campaign' | 'contact'

// ─── Settings payload ─────────────────────────────────────────────────────────
// Matches AgentControlsPayload interface in control-panel.ts exactly.

export interface AgentControlSettings {
  kill_switch?:             boolean
  allowed_channels?:        string[]   // 'email' | 'whatsapp' | 'voice'
  quiet_hours?:             { start: string; end: string; timezone: string } | null
  max_per_day?:             number
  approval_threshold?:      number     // 0.0 – 1.0
  require_call_approval?:   boolean
  max_unanswered_sequence?: number
}

// ─── Single control row ───────────────────────────────────────────────────────
// Matches the mapped row shape returned by GET /v1/agent-controls.

export interface AgentControl {
  id:          string
  scope:       ControlScope
  campaign_id: string | null
  contact_id:  string | null
  settings:    AgentControlSettings
  created_at:  string
  updated_at:  string
}

// ─── Response envelopes ───────────────────────────────────────────────────────

export interface AgentControlsResponse {
  controls: AgentControl[]
}

// Matches run row shape from GET /v1/agent-controls/runs
export interface AgentRun {
  id:           string
  contact:      { id: string; name: string; email?: string }
  campaign_id:  string | null
  trigger_type: string
  status:
    | 'queued' | 'running' | 'completed' | 'failed'
    | 'blocked_by_policy' | 'pending' | 'pending_human'
    | 'approved' | 'rejected'
  decision:     Record<string, unknown> | null
  cost_usd?:    number
  duration_ms?: number
  created_at:   string
  updated_at:   string
}

export interface AgentRunsResponse {
  runs:       AgentRun[]
  pagination: { limit: number; offset: number }
}

export interface PendingRunsResponse {
  runs:  AgentRun[]
  count: number
}

// ─── API methods ──────────────────────────────────────────────────────────────

export const agentApi = {

  // Controls CRUD ──────────────────────────────────────────────────────────────

  getControls: (): Promise<AgentControlsResponse> =>
    get<AgentControlsResponse>('/v1/agent-controls'),

  updateControls: (
    scope: ControlScope,
    payload: AgentControlSettings & { campaign_id?: string; contact_id?: string },
  ): Promise<{ ok: boolean; scope: string; settings: AgentControlSettings }> =>
    put(`/v1/agent-controls/${scope}`, payload),

  deleteControls: (
    scope: ControlScope,
    opts?: { campaign_id?: string; contact_id?: string },
  ): Promise<{ ok: boolean }> => {
    const qs = new URLSearchParams()
    if (opts?.campaign_id) qs.set('campaign_id', opts.campaign_id)
    if (opts?.contact_id)  qs.set('contact_id',  opts.contact_id)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return del<{ ok: boolean }>(`/v1/agent-controls/${scope}${suffix}`)
  },

  // Kill switch ────────────────────────────────────────────────────────────────

  activateKillSwitch: (payload: {
    scope:        ControlScope
    campaign_id?: string
    contact_id?:  string
    reason?:      string
  }): Promise<{ ok: boolean; kill_switch: boolean; scope: string }> =>
    post('/v1/agent-controls/kill-switch', payload),

  deactivateKillSwitch: (
    scope: ControlScope,
    opts?: { campaign_id?: string; contact_id?: string },
  ): Promise<{ ok: boolean; kill_switch: boolean; scope: string }> => {
    const qs = new URLSearchParams({ scope })
    if (opts?.campaign_id) qs.set('campaign_id', opts.campaign_id)
    if (opts?.contact_id)  qs.set('contact_id',  opts.contact_id)
    return del(`/v1/agent-controls/kill-switch?${qs.toString()}`)
  },

  // Run history ────────────────────────────────────────────────────────────────

  getRuns: (params?: {
    contact_id?:  string
    campaign_id?: string
    status?:      string
    limit?:       number
    offset?:      number
  }): Promise<AgentRunsResponse> =>
    get<AgentRunsResponse>('/v1/agent-controls/runs', params as Record<string, unknown>),

  getPendingRuns: (): Promise<PendingRunsResponse> =>
    get<PendingRunsResponse>('/v1/agent-controls/runs/pending'),

  // Run approval / rejection ───────────────────────────────────────────────────

  approveRun: (runId: string): Promise<{ ok: boolean; run_id: string; status: string }> =>
    post(`/v1/agent-controls/runs/${runId}/approve`),

  rejectRun: (
    runId: string,
    reason?: string,
  ): Promise<{ ok: boolean; run_id: string; status: string }> =>
    post(`/v1/agent-controls/runs/${runId}/reject`, { reason }),

  editRunDecision: async (
    runId: string,
    decision: Record<string, unknown>,
  ): Promise<{ ok: boolean; run_id: string }> => {
    const res: AxiosResponse<{ ok: boolean; run_id: string }> =
      await api.patch(`/v1/agent-controls/runs/${runId}/edit`, { decision })
    return res.data
  },

  // Action revocation ──────────────────────────────────────────────────────────

  revokeAction: (
    actionId: string,
    reason?: string,
  ): Promise<{ ok: boolean; action_id: string; status: string }> =>
    post(`/v1/agent-controls/actions/${actionId}/revoke`, { reason }),
}
