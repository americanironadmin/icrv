// src/pages/Dashboard.tsx
// Real-time operations view — polls /v1/dashboard/* every 10 seconds

import React from 'react'
import { usePolling } from '@/hooks/usePolling'
import { dashboardApi, type DashboardStats, type ActivityItem } from '@/api/dashboard'
import { formatDistanceToNow } from 'date-fns'

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACTIVITY_ICONS: Record<string, string> = {
  email_sent:     '📧',
  whatsapp_sent:  '💬',
  call_made:      '📞',
  call_received:  '📲',
  ai_action:      '⚡',
  contact_created:'◈',
}

const ACTIVITY_COLORS: Record<string, string> = {
  email_sent:     'var(--blue)',
  whatsapp_sent:  'var(--green)',
  call_made:      'var(--accent)',
  call_received:  'var(--purple)',
  ai_action:      'var(--yellow)',
  contact_created:'var(--text-muted)',
}

function statusBadge(status: string) {
  if (['sent', 'connected', 'completed', 'executed'].includes(status)) {
    return <span className="badge badge-green">{status}</span>
  }
  if (['failed', 'bounced', 'error'].includes(status)) {
    return <span className="badge badge-red">{status}</span>
  }
  if (['queued', 'pending', 'ringing'].includes(status)) {
    return <span className="badge badge-yellow">{status}</span>
  }
  return <span className="badge badge-gray">{status}</span>
}

// ── Metric Card ──────────────────────────────────────────────────────────────

interface MetricCardProps {
  label: string
  value: number | string
  sub?: string
  color: string
}

function MetricCard({ label, value, sub, color }: MetricCardProps) {
  return (
    <div className={`metric-card mc-${color}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  )
}

// ── Activity Row ─────────────────────────────────────────────────────────────

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.75rem',
        padding: '0.65rem 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <span
        style={{
          fontSize: '0.9rem',
          flexShrink: 0,
          marginTop: '0.1rem',
          color: ACTIVITY_COLORS[item.type] ?? 'var(--text-muted)',
        }}
      >
        {ACTIVITY_ICONS[item.type] ?? '◦'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500 }}>
            {item.contact_name}
          </span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {item.detail}
          </span>
          {statusBadge(item.status)}
        </div>
        <div
          style={{
            fontSize: '0.68rem',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            marginTop: '0.2rem',
          }}
        >
          {formatDistanceToNow(new Date(item.occurred_at), { addSuffix: true })}
        </div>
      </div>
    </div>
  )
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const {
    data: stats,
    loading: statsLoading,
    error: statsError,
  } = usePolling<DashboardStats>({
    fetchFn: dashboardApi.getStats,
    intervalMs: 10_000,
  })

  const { data: activityData, loading: activityLoading } = usePolling({
    fetchFn: () => dashboardApi.getActivity(25),
    intervalMs: 10_000,
  })

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Operations Dashboard</h1>
          <p className="page-subtitle">Live system overview — updates every 10 seconds</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span className="status-dot live" />
          <span style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>
            LIVE
          </span>
        </div>
      </div>

      {/* Error banner */}
      {statsError && (
        <div
          style={{
            background: 'var(--red-dim)',
            border: '1px solid var(--red)',
            borderRadius: 'var(--radius-md)',
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            fontSize: '0.82rem',
            color: 'var(--red)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          ⚠ API Error: {statsError} — retrying automatically
        </div>
      )}

      {/* Metrics */}
      <div className="metrics-grid" style={{ marginBottom: '1.5rem' }}>
        {statsLoading && !stats ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="metric-card">
              <div className="skeleton" style={{ height: '12px', width: '60%', marginBottom: '0.75rem' }} />
              <div className="skeleton" style={{ height: '40px', width: '80%' }} />
            </div>
          ))
        ) : stats ? (
          <>
            <MetricCard label="Total Contacts" value={stats.total_contacts}    color="amber"  sub="in CRM" />
            <MetricCard label="Active Campaigns" value={stats.active_campaigns} color="green"  sub="running" />
            <MetricCard label="Emails Sent" value={stats.emails_sent}          color="blue"   sub="all time" />
            <MetricCard label="WhatsApp Sent" value={stats.whatsapp_sent}      color="purple" sub="all time" />
            <MetricCard label="Calls Made" value={stats.calls_made}            color="amber"  sub="all time" />
            <MetricCard label="AI Actions" value={stats.ai_actions_triggered}  color="red"    sub="agent runs" />
          </>
        ) : null}
      </div>

      {/* Activity Feed */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Live Activity Feed</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.65rem',
              color: 'var(--text-muted)',
            }}
          >
            {activityData?.total ?? 0} events
          </span>
        </div>

        {activityLoading && !activityData ? (
          <div style={{ padding: '0.5rem 0' }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.75rem', padding: '0.65rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="skeleton" style={{ width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div className="skeleton" style={{ height: '12px', width: '60%', marginBottom: '0.35rem' }} />
                  <div className="skeleton" style={{ height: '10px', width: '30%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : activityData?.items.length ? (
          <div>
            {activityData.items.map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">◌</div>
            <div className="empty-state-title">No activity yet</div>
            <p className="text-sm">Activity will appear here as the system processes events</p>
          </div>
        )}
      </div>
    </div>
  )
}
