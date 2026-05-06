// src/pages/AIControlPanel.tsx
// AI Agent Control Panel — wired exclusively to /v1/agent-controls
//
// All routes verified against workers/icrv-agent/src/control-panel.ts
// No mock data, no simulated state, no non-existent endpoints.

import React, { useState, useEffect, useCallback } from 'react'
import {
  agentApi,
  type AgentControl,
  type AgentControlSettings,
  type AgentRun,
  type ControlScope,
} from '@/api/agent'
import { useApp, isAgentActive } from '@/context/AppContext'
import { formatDistanceToNow, format } from 'date-fns'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CHANNELS = ['email', 'whatsapp', 'voice'] as const
type Channel = (typeof CHANNELS)[number]

const CHANNEL_LABELS: Record<Channel, string> = {
  email:     'Email',
  whatsapp:  'WhatsApp',
  voice:     'Voice',
}

const RUN_STATUS_CLASS: Record<string, string> = {
  queued:              'badge-gray',
  running:             'badge-yellow',
  completed:           'badge-green',
  failed:              'badge-red',
  blocked_by_policy:   'badge-purple',
  pending:             'badge-yellow',
  pending_human:       'badge-yellow',
  approved:            'badge-green',
  rejected:            'badge-red',
}

function scopeControl(
  controls: AgentControl[],
  scope: ControlScope,
): AgentControl | undefined {
  return controls.find((c) => c.scope === scope)
}

// ─── Reject modal ─────────────────────────────────────────────────────────────

function RejectModal({
  runId,
  onClose,
  onDone,
}: {
  runId: string
  onClose: () => void
  onDone: () => void
}) {
  const { showToast } = useApp()
  const [reason, setReason]   = useState('')
  const [typed,  setTyped]    = useState('')
  const [busy,   setBusy]     = useState(false)
  // PR 7 / L5: type REJECT to enable the destructive button.
  const enabled = typed.trim() === 'REJECT'

  const submit = async () => {
    if (!enabled) return
    setBusy(true)
    try {
      await agentApi.rejectRun(runId, reason || undefined)
      showToast({ type: 'success', title: 'Run rejected' })
      onDone()
    } catch (err) {
      showToast({ type: 'error', title: 'Reject failed', message: String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Reject Run
          </h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Reason (optional)</label>
            <textarea
              className="form-control"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why this run is being rejected…"
              style={{ minHeight: 80 }}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="reject-confirm">
              Type <code style={{ color: 'var(--red)', fontWeight: 700 }}>REJECT</code> to enable the button
            </label>
            <input
              id="reject-confirm"
              className="form-control"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={submit} disabled={busy || !enabled}>
            {busy ? 'Rejecting…' : 'Reject Run'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Kill switch confirm modal ────────────────────────────────────────────────

function KillSwitchModal({
  activating,
  onClose,
  onConfirm,
}: {
  activating: boolean
  onClose: () => void
  onConfirm: (reason?: string) => void
}) {
  const [reason, setReason] = useState('')
  // PR 7 / L5: type STOP to enable. Only the destructive (activate) path is
  // gated — re-enabling the agent is non-destructive.
  const [typed, setTyped]   = useState('')
  const enabled = !activating || typed.trim() === 'STOP'

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: activating ? 'var(--red)' : 'var(--green)' }}>
            {activating ? '⚠ Activate Kill Switch' : '↩ Deactivate Kill Switch'}
          </h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            {activating
              ? 'This will immediately halt ALL AI agent activity across the entire tenant. No emails, WhatsApp messages, or calls will be initiated until re-enabled.'
              : 'This will re-enable AI agent activity. The agent will resume processing queued runs according to configured controls.'}
          </p>
          {activating && (
            <>
              <div className="form-group">
                <label className="form-label">Reason (optional)</label>
                <input
                  className="form-control"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Investigating anomalous send volume"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="kill-confirm">
                  Type <code style={{ color: 'var(--red)', fontWeight: 700 }}>STOP</code> to enable the button
                </label>
                <input
                  id="kill-confirm"
                  className="form-control"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className={activating ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={!enabled}
            onClick={() => onConfirm(reason || undefined)}
          >
            {activating ? 'Activate Kill Switch' : 'Re-enable Agent'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Pending run row ──────────────────────────────────────────────────────────

function PendingRunRow({
  run,
  onApprove,
  onReject,
}: {
  run: AgentRun
  onApprove: (id: string) => void
  onReject:  (id: string) => void
}) {
  return (
    <tr>
      <td className="td-name">{run.contact.name}</td>
      <td>
        <span className="badge badge-gray" style={{ fontSize: '0.65rem' }}>
          {run.trigger_type.replace(/_/g, ' ')}
        </span>
      </td>
      <td>
        <span className={`badge ${RUN_STATUS_CLASS[run.status] ?? 'badge-gray'}`}>
          {run.status.replace(/_/g, ' ')}
        </span>
      </td>
      <td className="td-mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        {formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}
      </td>
      <td>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button
            className="btn btn-primary btn-sm"
            style={{ fontSize: '0.7rem', padding: '0.2rem 0.6rem' }}
            onClick={() => onApprove(run.id)}
          >
            Approve
          </button>
          <button
            className="btn btn-danger btn-sm"
            style={{ fontSize: '0.7rem', padding: '0.2rem 0.6rem' }}
            onClick={() => onReject(run.id)}
          >
            Reject
          </button>
        </div>
      </td>
    </tr>
  )
}

// ─── Run history row ──────────────────────────────────────────────────────────

function RunHistoryRow({ run }: { run: AgentRun }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr
        style={{ cursor: run.decision ? 'pointer' : undefined, background: expanded ? 'var(--bg-active)' : undefined }}
        onClick={() => run.decision && setExpanded((p) => !p)}
      >
        <td className="td-name">{run.contact.name}</td>
        <td>
          <span className="badge badge-gray" style={{ fontSize: '0.65rem' }}>
            {run.trigger_type.replace(/_/g, ' ')}
          </span>
        </td>
        <td>
          <span className={`badge ${RUN_STATUS_CLASS[run.status] ?? 'badge-gray'}`}>
            {run.status.replace(/_/g, ' ')}
          </span>
        </td>
        <td className="td-mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {run.duration_ms != null ? `${run.duration_ms}ms` : '—'}
        </td>
        <td className="td-mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '—'}
        </td>
        <td className="td-mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {format(new Date(run.created_at), 'MMM d HH:mm')}
        </td>
      </tr>
      {expanded && run.decision && (
        <tr>
          <td colSpan={6} style={{ padding: '0 0.75rem 0.75rem' }}>
            <pre
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '0.75rem',
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-secondary)',
                overflow: 'auto',
                maxHeight: 200,
              }}
            >
              {JSON.stringify(run.decision, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AIControlPanel() {
  const { showToast, agentControls, refreshAgentControls } = useApp()

  // ── Local state ────────────────────────────────────────────────────────────
  const [pendingRuns,   setPendingRuns]   = useState<AgentRun[]>([])
  const [runHistory,    setRunHistory]    = useState<AgentRun[]>([])
  const [loadingPending, setLoadingPending] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [savingControls, setSavingControls] = useState(false)

  // Controls being edited (tenant scope)
  const tenantControl = agentControls
    ? (agentControls.controls.find((c) => c.scope === 'tenant') ?? null)
    : null

  const globalControl = agentControls
    ? (agentControls.controls.find((c) => c.scope === 'global') ?? null)
    : null

  const [draft, setDraft] = useState<AgentControlSettings>({})

  // Sync draft from tenantControl when it loads
  useEffect(() => {
    if (tenantControl) setDraft(tenantControl.settings)
  }, [tenantControl?.id])

  // Kill switch modals
  const [killSwitchModal, setKillSwitchModal] = useState<'activate' | 'deactivate' | null>(null)

  // Reject modal
  const [rejectRunId, setRejectRunId] = useState<string | null>(null)

  // Active tab
  const [tab, setTab] = useState<'controls' | 'pending' | 'history'>('controls')

  const agentActive = isAgentActive(agentControls)

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadPending = useCallback(async () => {
    setLoadingPending(true)
    try {
      const res = await agentApi.getPendingRuns()
      setPendingRuns(res.runs)
    } catch (err) {
      showToast({ type: 'error', title: 'Failed to load pending runs', message: String(err) })
    } finally {
      setLoadingPending(false)
    }
  }, [showToast])

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const res = await agentApi.getRuns({ limit: 50 })
      setRunHistory(res.runs)
    } catch (err) {
      showToast({ type: 'error', title: 'Failed to load run history', message: String(err) })
    } finally {
      setLoadingHistory(false)
    }
  }, [showToast])

  useEffect(() => {
    loadPending()
    loadHistory()
    const id = setInterval(() => { loadPending(); loadHistory() }, 15_000)
    return () => clearInterval(id)
  }, [loadPending, loadHistory])

  // ── Save tenant controls ───────────────────────────────────────────────────

  const saveControls = async () => {
    setSavingControls(true)
    try {
      await agentApi.updateControls('tenant', draft)
      showToast({ type: 'success', title: 'Controls saved' })
      refreshAgentControls()
    } catch (err) {
      showToast({ type: 'error', title: 'Save failed', message: String(err) })
    } finally {
      setSavingControls(false)
    }
  }

  // ── Kill switch ────────────────────────────────────────────────────────────

  const handleKillSwitch = async (reason?: string) => {
    setKillSwitchModal(null)
    try {
      if (agentActive) {
        await agentApi.activateKillSwitch({ scope: 'tenant', reason })
        setDraft((d) => ({ ...d, kill_switch: true }))
        showToast({ type: 'warning', title: 'Kill switch activated — agent halted' })
      } else {
        await agentApi.deactivateKillSwitch('tenant')
        setDraft((d) => ({ ...d, kill_switch: false }))
        showToast({ type: 'success', title: 'Kill switch cleared — agent active' })
      }
      refreshAgentControls()
    } catch (err) {
      showToast({ type: 'error', title: 'Kill switch operation failed', message: String(err) })
    }
  }

  // ── Approve run ────────────────────────────────────────────────────────────

  const handleApprove = async (runId: string) => {
    try {
      await agentApi.approveRun(runId)
      showToast({ type: 'success', title: 'Run approved — queued for dispatch' })
      loadPending()
      loadHistory()
    } catch (err) {
      showToast({ type: 'error', title: 'Approve failed', message: String(err) })
    }
  }

  // ── Channel toggle helper ──────────────────────────────────────────────────

  const toggleChannel = (ch: string) => {
    const current = draft.allowed_channels ?? ['email', 'whatsapp', 'voice']
    const next = current.includes(ch)
      ? current.filter((c) => c !== ch)
      : [...current, ch]
    setDraft((p) => ({ ...p, allowed_channels: next }))
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Header row */}
      <div className="page-header">
        <div>
          <h1 className="page-title">AI Control Panel</h1>
          <p className="page-subtitle">
            Configure and monitor the AI agent — all changes write to{' '}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
              /v1/agent-controls
            </span>
          </p>
        </div>

        {/* Kill switch */}
        <button
          className={agentActive ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={() => setKillSwitchModal(agentActive ? 'activate' : 'deactivate')}
          style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {agentActive ? '⚠ Activate Kill Switch' : '↩ Re-enable Agent'}
        </button>
      </div>

      {/* Status banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.75rem 1rem',
          marginBottom: '1.25rem',
          background: agentActive ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
          border: `1px solid ${agentActive ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
          borderRadius: 'var(--radius-md)',
        }}
      >
        <span
          className="status-dot"
          style={{
            background: agentActive ? 'var(--green)' : 'var(--red)',
            boxShadow: agentActive ? '0 0 8px var(--green)' : 'none',
            animation: agentActive ? 'pulse 2s infinite' : 'none',
            width: 10,
            height: 10,
            flexShrink: 0,
          }}
        />
        <div>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.9rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: agentActive ? 'var(--green)' : 'var(--red)' }}>
            Agent {agentActive ? 'Active' : 'Halted'}
          </span>
          {!agentActive && (
            <span style={{ marginLeft: '0.75rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Kill switch is engaged — no actions will be dispatched
            </span>
          )}
        </div>

        {/* Scope summary */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {agentControls?.controls.map((c) => (
            <span key={c.id} className="badge badge-gray" style={{ fontSize: '0.62rem' }}>
              {c.scope}{c.settings.kill_switch ? ' 🔴' : ' 🟢'}
            </span>
          ))}
        </div>
      </div>

      {/* Pending runs badge */}
      {pendingRuns.length > 0 && (
        <div
          style={{
            padding: '0.6rem 1rem',
            marginBottom: '1rem',
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.82rem',
            color: 'var(--accent)',
            cursor: 'pointer',
          }}
          onClick={() => setTab('pending')}
        >
          ⚠ {pendingRuns.length} run{pendingRuns.length !== 1 ? 's' : ''} pending human review — click to review
        </div>
      )}

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: '1.25rem' }}>
        {(['controls', 'pending', 'history'] as const).map((t) => (
          <button
            key={t}
            className={`tab-btn ${tab === t ? 'tab-btn-active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'controls' ? 'Controls'
              : t === 'pending' ? `Pending Review${pendingRuns.length > 0 ? ` (${pendingRuns.length})` : ''}`
              : 'Run History'}
          </button>
        ))}
      </div>

      {/* ── TAB: Controls ────────────────────────────────────────────────────── */}
      {tab === 'controls' && (
        <div style={{ display: 'grid', gap: '1.25rem' }}>

          {/* Allowed channels */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Allowed Channels</span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                PUT /v1/agent-controls/tenant
              </span>
            </div>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', padding: '0.25rem 0' }}>
              {CHANNELS.map((ch) => {
                const enabled = (draft.allowed_channels ?? ['email', 'whatsapp', 'voice']).includes(ch)
                return (
                  <label
                    key={ch}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
                  >
                    <div
                      className={`toggle ${enabled ? 'toggle-on' : ''}`}
                      onClick={() => toggleChannel(ch)}
                    />
                    <span style={{ fontSize: '0.84rem', color: enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {CHANNEL_LABELS[ch]}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Daily limits */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Daily Limits</span>
            </div>
            <div style={{ display: 'grid', gap: '1.25rem' }}>

              {/* max_per_day */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <label className="form-label" style={{ margin: 0 }}>Max actions per contact per day</label>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--accent)' }}>
                    {draft.max_per_day ?? 3}
                  </span>
                </div>
                <input
                  type="range" min={1} max={20} step={1}
                  className="slider"
                  value={draft.max_per_day ?? 3}
                  onChange={(e) => setDraft((p) => ({ ...p, max_per_day: parseInt(e.target.value) }))}
                />
              </div>

              {/* max_unanswered_sequence */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <label className="form-label" style={{ margin: 0 }}>Max unanswered follow-ups before stopping</label>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--accent)' }}>
                    {draft.max_unanswered_sequence ?? 3}
                  </span>
                </div>
                <input
                  type="range" min={1} max={10} step={1}
                  className="slider"
                  value={draft.max_unanswered_sequence ?? 3}
                  onChange={(e) => setDraft((p) => ({ ...p, max_unanswered_sequence: parseInt(e.target.value) }))}
                />
              </div>

              {/* approval_threshold */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <label className="form-label" style={{ margin: 0 }}>Approval confidence threshold</label>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--accent)' }}>
                    {((draft.approval_threshold ?? 0.8) * 100).toFixed(0)}%
                  </span>
                </div>
                <input
                  type="range" min={0} max={100} step={5}
                  className="slider"
                  value={Math.round((draft.approval_threshold ?? 0.8) * 100)}
                  onChange={(e) => setDraft((p) => ({ ...p, approval_threshold: parseInt(e.target.value) / 100 }))}
                />
                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                  Runs with confidence below this threshold require human approval before dispatch.
                </p>
              </div>

            </div>
          </div>

          {/* Approval settings */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Approval Requirements</span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
              <div
                className={`toggle ${draft.require_call_approval ? 'toggle-on' : ''}`}
                onClick={() => setDraft((p) => ({ ...p, require_call_approval: !p.require_call_approval }))}
              />
              <div>
                <div style={{ fontSize: '0.84rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                  Require human approval before placing calls
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                  All voice calls will be queued as pending until an operator approves.
                </div>
              </div>
            </label>
          </div>

          {/* Quiet hours */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Quiet Hours</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr', gap: '1rem', alignItems: 'end' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Start (HH:MM)</label>
                <input
                  className="form-control form-control-mono"
                  placeholder="22:00"
                  value={draft.quiet_hours?.start ?? ''}
                  onChange={(e) => setDraft((p) => ({
                    ...p,
                    quiet_hours: { ...(p.quiet_hours ?? { end: '08:00', timezone: 'UTC' }), start: e.target.value },
                  }))}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">End (HH:MM)</label>
                <input
                  className="form-control form-control-mono"
                  placeholder="08:00"
                  value={draft.quiet_hours?.end ?? ''}
                  onChange={(e) => setDraft((p) => ({
                    ...p,
                    quiet_hours: { ...(p.quiet_hours ?? { start: '22:00', timezone: 'UTC' }), end: e.target.value },
                  }))}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Timezone</label>
                <input
                  className="form-control form-control-mono"
                  placeholder="America/New_York"
                  value={draft.quiet_hours?.timezone ?? ''}
                  onChange={(e) => setDraft((p) => ({
                    ...p,
                    quiet_hours: { ...(p.quiet_hours ?? { start: '22:00', end: '08:00' }), timezone: e.target.value },
                  }))}
                />
              </div>
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <button
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}
                onClick={() => setDraft((p) => ({ ...p, quiet_hours: null }))}
              >
                Clear quiet hours
              </button>
            </div>
          </div>

          {/* Save */}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button
              className="btn btn-secondary"
              onClick={() => tenantControl && setDraft(tenantControl.settings)}
            >
              Reset
            </button>
            <button className="btn btn-primary" onClick={saveControls} disabled={savingControls}>
              {savingControls ? 'Saving…' : 'Save Controls'}
            </button>
          </div>

          {/* Other active scopes (read-only overview) */}
          {agentControls && agentControls.controls.filter((c) => c.scope !== 'tenant').length > 0 && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Other Active Control Scopes</span>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Campaign / Contact</th>
                    <th>Kill Switch</th>
                    <th>Max/Day</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {agentControls.controls
                    .filter((c) => c.scope !== 'tenant')
                    .map((c) => (
                      <tr key={c.id}>
                        <td><span className="badge badge-gray">{c.scope}</span></td>
                        <td className="td-mono" style={{ fontSize: '0.72rem' }}>
                          {c.campaign_id ?? c.contact_id ?? '—'}
                        </td>
                        <td>
                          {c.settings.kill_switch
                            ? <span className="badge badge-red">ON</span>
                            : <span className="badge badge-green">OFF</span>}
                        </td>
                        <td className="td-mono">{c.settings.max_per_day ?? '—'}</td>
                        <td className="td-mono" style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {formatDistanceToNow(new Date(c.updated_at), { addSuffix: true })}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Pending review ───────────────────────────────────────────────── */}
      {tab === 'pending' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Pending Human Review</span>
            <button className="btn btn-ghost btn-sm" onClick={loadPending} disabled={loadingPending}>
              {loadingPending ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>

          {loadingPending && pendingRuns.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
              <div className="skeleton" style={{ height: 12, width: '60%', margin: '0 auto' }} />
            </div>
          ) : pendingRuns.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">✓</div>
              <div className="empty-state-title">No pending runs</div>
              <p className="text-sm">All agent runs have been processed.</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th>Queued</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingRuns.map((run) => (
                  <PendingRunRow
                    key={run.id}
                    run={run}
                    onApprove={handleApprove}
                    onReject={(id) => setRejectRunId(id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── TAB: Run history ──────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Run History</span>
            <button className="btn btn-ghost btn-sm" onClick={loadHistory} disabled={loadingHistory}>
              {loadingHistory ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>

          {loadingHistory && runHistory.length === 0 ? (
            <div style={{ padding: '1rem 0' }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.75rem', padding: '0.5rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div className="skeleton" style={{ height: 12, width: '20%' }} />
                  <div className="skeleton" style={{ height: 12, width: '12%' }} />
                  <div className="skeleton" style={{ height: 12, width: '10%' }} />
                </div>
              ))}
            </div>
          ) : runHistory.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">◌</div>
              <div className="empty-state-title">No runs yet</div>
              <p className="text-sm">Agent runs will appear here once the system processes contacts.</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Cost</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runHistory.map((run) => (
                  <RunHistoryRow key={run.id} run={run} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Kill switch modal */}
      {killSwitchModal && (
        <KillSwitchModal
          activating={killSwitchModal === 'activate'}
          onClose={() => setKillSwitchModal(null)}
          onConfirm={handleKillSwitch}
        />
      )}

      {/* Reject modal */}
      {rejectRunId && (
        <RejectModal
          runId={rejectRunId}
          onClose={() => setRejectRunId(null)}
          onDone={() => { setRejectRunId(null); loadPending(); loadHistory() }}
        />
      )}
    </div>
  )
}
