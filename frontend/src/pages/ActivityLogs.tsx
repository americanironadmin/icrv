// src/pages/ActivityLogs.tsx
// Full activity log with filter by type/date/contact, expandable entries

import React, { useState, useEffect, useCallback } from 'react'
import { logsApi, type LogEntry, type LogEventType } from '@/api/logs'
import { formatDistanceToNow, format } from 'date-fns'

// ── Event type config ─────────────────────────────────────────────────────────

const EVENT_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  email_sent:       { label: 'Email Sent',        color: 'badge-blue',   icon: '📧' },
  email_opened:     { label: 'Email Opened',       color: 'badge-blue',   icon: '👁' },
  email_clicked:    { label: 'Email Clicked',      color: 'badge-blue',   icon: '🔗' },
  email_bounced:    { label: 'Email Bounced',      color: 'badge-red',    icon: '↩' },
  whatsapp_sent:    { label: 'WhatsApp Sent',      color: 'badge-green',  icon: '💬' },
  whatsapp_delivered:{ label: 'WA Delivered',      color: 'badge-green',  icon: '✓✓' },
  whatsapp_read:    { label: 'WA Read',            color: 'badge-green',  icon: '👁' },
  whatsapp_replied: { label: 'WA Replied',         color: 'badge-green',  icon: '↩' },
  call_initiated:   { label: 'Call Initiated',     color: 'badge-accent', icon: '📞' },
  call_connected:   { label: 'Call Connected',     color: 'badge-accent', icon: '📞' },
  call_ended:       { label: 'Call Ended',         color: 'badge-gray',   icon: '☎' },
  call_voicemail:   { label: 'Voicemail',          color: 'badge-yellow', icon: '📨' },
  ai_action:        { label: 'AI Action',          color: 'badge-purple', icon: '⚡' },
  ai_run_started:   { label: 'AI Run Started',     color: 'badge-purple', icon: '▶' },
  ai_run_completed: { label: 'AI Run Completed',   color: 'badge-purple', icon: '✓' },
  contact_created:  { label: 'Contact Created',    color: 'badge-gray',   icon: '◈' },
  contact_updated:  { label: 'Contact Updated',    color: 'badge-gray',   icon: '◈' },
  campaign_launched:{ label: 'Campaign Launched',  color: 'badge-green',  icon: '▶' },
  unsubscribe:      { label: 'Unsubscribe',        color: 'badge-red',    icon: '🚫' },
}

const ALL_EVENT_TYPES = Object.keys(EVENT_CONFIG) as LogEventType[]

// ── Log Entry Row ─────────────────────────────────────────────────────────────

function LogRow({ entry, expanded, onToggle }: { entry: LogEntry; expanded: boolean; onToggle: () => void }) {
  const cfg = EVENT_CONFIG[entry.event_type] ?? { label: entry.event_type, color: 'badge-gray', icon: '◦' }

  return (
    <>
      <tr
        style={{ cursor: 'pointer', background: expanded ? 'var(--bg-active)' : undefined }}
        onClick={onToggle}
      >
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.85rem', flexShrink: 0 }}>{cfg.icon}</span>
            <span className={`badge ${cfg.color}`}>{cfg.label}</span>
          </div>
        </td>
        <td className="td-name">
          {entry.contact_name ?? '—'}
          {entry.contact_email && (
            <div className="text-xs text-muted font-mono">{entry.contact_email}</div>
          )}
        </td>
        <td>
          {entry.campaign_name ? (
            <span className="badge badge-gray" style={{ fontSize: '0.65rem' }}>{entry.campaign_name}</span>
          ) : '—'}
        </td>
        <td>
          <span className={`badge ${['sent', 'delivered', 'connected', 'completed', 'executed', 'read'].includes(entry.status) ? 'badge-green' : ['failed', 'bounced', 'error'].includes(entry.status) ? 'badge-red' : 'badge-gray'}`}>
            {entry.status}
          </span>
        </td>
        <td className="td-mono text-xs" title={format(new Date(entry.occurred_at), 'yyyy-MM-dd HH:mm:ss')}>
          {formatDistanceToNow(new Date(entry.occurred_at), { addSuffix: true })}
        </td>
        <td style={{ width: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
          {expanded ? '▲' : '▼'}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: '0 0.75rem 0.75rem', background: 'var(--bg-base)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.5rem' }}>
              <div>
                <div className="section-label">Payload</div>
                <pre className="code-block">
                  {entry.payload ? JSON.stringify(entry.payload, null, 2) : 'No payload'}
                </pre>
              </div>
              <div>
                <div className="section-label">Response / Detail</div>
                <pre className="code-block">
                  {entry.response ? JSON.stringify(entry.response, null, 2) : 'No response data'}
                </pre>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
              {entry.message_id && (
                <span className="text-xs font-mono text-muted">msg_id: {entry.message_id}</span>
              )}
              {entry.call_log_id && (
                <span className="text-xs font-mono text-muted">call_id: {entry.call_log_id}</span>
              )}
              {entry.agent_run_id && (
                <span className="text-xs font-mono text-muted">run_id: {entry.agent_run_id}</span>
              )}
              <span className="text-xs font-mono text-muted">
                {format(new Date(entry.occurred_at), 'yyyy-MM-dd HH:mm:ss')} UTC
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main Logs Page ────────────────────────────────────────────────────────────

export default function ActivityLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const perPage = 30

  // Filters
  const [typeFilter, setTypeFilter] = useState<LogEventType | ''>('')
  const [contactFilter, setContactFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await logsApi.list({
        page,
        per_page: perPage,
        event_type: typeFilter || undefined,
        contact_id: contactFilter || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        sort: 'desc',
      })
      setLogs(res.logs)
      setTotal(res.total)
    } catch {
      // interceptor handles
    } finally {
      setLoading(false)
    }
  }, [page, typeFilter, contactFilter, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  // Auto-poll
  useEffect(() => {
    const id = setInterval(load, 15_000)
    return () => clearInterval(id)
  }, [load])

  const totalPages = Math.ceil(total / perPage)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity Logs</h1>
          <p className="page-subtitle">{total.toLocaleString()} events · auto-refreshes every 15s</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="card" style={{ marginBottom: '1rem', padding: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: '1 1 180px' }}>
            <label className="form-label">Event Type</label>
            <select className="form-control" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value as LogEventType | ''); setPage(1) }}>
              <option value="">All Events</option>
              {ALL_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>{EVENT_CONFIG[t]?.label ?? t}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: '1 1 180px' }}>
            <label className="form-label">Contact ID</label>
            <input
              className="form-control form-control-mono"
              placeholder="contact_uuid"
              value={contactFilter}
              onChange={(e) => { setContactFilter(e.target.value); setPage(1) }}
            />
          </div>
          <div className="form-group" style={{ flex: '1 1 150px' }}>
            <label className="form-label">Date From</label>
            <input
              className="form-control"
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(1) }}
            />
          </div>
          <div className="form-group" style={{ flex: '1 1 150px' }}>
            <label className="form-label">Date To</label>
            <input
              className="form-control"
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1) }}
            />
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { setTypeFilter(''); setContactFilter(''); setDateFrom(''); setDateTo(''); setPage(1) }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Event type quick-filters */}
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {['email_sent', 'whatsapp_sent', 'call_initiated', 'ai_action', 'unsubscribe'].map((t) => (
          <button
            key={t}
            className={`btn btn-sm ${typeFilter === t ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setTypeFilter(typeFilter === t ? '' : t as LogEventType); setPage(1) }}
          >
            {EVENT_CONFIG[t]?.icon} {EVENT_CONFIG[t]?.label ?? t}
          </button>
        ))}
      </div>

      {/* Logs table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Contact</th>
                <th>Campaign</th>
                <th>Status</th>
                <th>Time</th>
                <th style={{ width: '24px' }} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j}><div className="skeleton" style={{ height: '12px' }} /></td>
                    ))}
                  </tr>
                ))
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">
                      <div className="empty-state-icon">≡</div>
                      <div className="empty-state-title">No logs found</div>
                      <p className="text-sm">Adjust filters or wait for system activity</p>
                    </div>
                  </td>
                </tr>
              ) : (
                logs.map((entry) => (
                  <LogRow
                    key={entry.id}
                    entry={entry}
                    expanded={expanded === entry.id}
                    onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border-subtle)' }}>
          <div className="pagination">
            <span>{total} total</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{page} / {Math.max(1, totalPages)}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next →</button>
          </div>
        </div>
      </div>
    </div>
  )
}
