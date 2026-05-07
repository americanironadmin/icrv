// src/pages/Analytics.tsx — Phase 4 analytics dashboard.

import React, { useEffect, useState } from 'react'
import { analyticsApi, type Period, type AnalyticsOverview, type AnalyticsCampaign } from '@/api/analytics'
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'

const PIE_COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#eab308']

export default function Analytics() {
  const [period, setPeriod] = useState<Period>(30)
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [campaigns, setCampaigns] = useState<AnalyticsCampaign[]>([])
  const [hourly, setHourly] = useState<Array<{ hour: number; opens: number }>>([])
  const [statuses, setStatuses] = useState<Array<{ status: string; n: number }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      analyticsApi.overview(period).then(setOverview),
      analyticsApi.campaigns(period).then((r) => setCampaigns(r.campaigns)),
      analyticsApi.opensByHour(period).then((r) => setHourly(r.buckets)),
      analyticsApi.emailStatus(period).then((r) => setStatuses(r.statuses)),
    ]).catch(() => null).finally(() => setLoading(false))
  }, [period])

  const csv = () => {
    if (!campaigns.length) return
    const header = ['name','status','sent','opens','clicks','bounces','open_rate','click_rate']
    const rows = campaigns.map((c) => header.map((h) => String((c as unknown as Record<string, unknown>)[h] ?? '')).join(','))
    const blob = new Blob([header.join(',') + '\n' + rows.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `analytics_${period}d.csv`; a.click()
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1280 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.85rem', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Analytics</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Email engagement summary across all channels.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          {([7, 30, 90, 'all'] as Period[]).map((p) => (
            <button key={String(p)} onClick={() => setPeriod(p)} className={`btn ${period === p ? 'btn-primary' : 'btn-ghost'} btn-sm`}>
              {p === 'all' ? 'All' : `${p}d`}
            </button>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={csv}>Export CSV</button>
        </div>
      </div>

      {loading || !overview ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.85rem', marginBottom: '1.25rem' }}>
            <Metric label="Total sent"      value={overview.total_sent.toLocaleString()} />
            <Metric label="Avg open rate"   value={`${overview.avg_open}%`} />
            <Metric label="Avg click rate"  value={`${overview.avg_click}%`} />
            <Metric label="Delivery"        value={`${overview.delivery}%`} />
            <Metric label="Bounced"         value={overview.total_bounced.toLocaleString()} />
            <Metric label="Unsubscribed"    value={overview.unsubscribed.toLocaleString()} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
            <Card title="Campaign performance">
              {campaigns.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={campaigns.slice(0, 12)}>
                    <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} />
                    <Legend wrapperStyle={{ color: 'var(--text-secondary)', fontSize: 12 }} />
                    <Bar dataKey="sent"   fill="#3b82f6" />
                    <Bar dataKey="opens"  fill="#f59e0b" />
                    <Bar dataKey="clicks" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>

            <Card title="Email status breakdown">
              {statuses.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie dataKey="n" nameKey="status" data={statuses} outerRadius={90}>
                      {statuses.map((_e, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }} />
                    <Legend wrapperStyle={{ color: 'var(--text-secondary)', fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </Card>
          </div>

          <Card title="Opens by hour of day">
            {hourly.every((b) => b.opens === 0) ? <Empty /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={hourly}>
                  <XAxis dataKey="hour" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }} />
                  <Bar dataKey="opens" fill="#f59e0b" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>

          <Card title="All campaigns">
            {campaigns.length === 0 ? <Empty /> : (
              <table>
                <thead>
                  <tr><th>Campaign</th><th>Status</th><th>Sent</th><th>Opens</th><th>Open %</th><th>Clicks</th><th>Click %</th><th>Bounces</th></tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td><span className={`badge badge-${c.status === 'active' ? 'green' : 'ghost'}`}>{c.status}</span></td>
                      <td className="td-mono">{c.sent}</td>
                      <td className="td-mono">{c.opens}</td>
                      <td className="td-mono">{c.open_rate}%</td>
                      <td className="td-mono">{c.clicks}</td>
                      <td className="td-mono">{c.click_rate}%</td>
                      <td className="td-mono">{c.bounces}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: '0.85rem 1rem' }}>
      <div style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontFamily: 'var(--font-display)', color: 'var(--accent)', marginTop: '0.2rem' }}>{value}</div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: '0.85rem 1rem', marginBottom: '1rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.85rem', color: 'var(--accent)', marginBottom: '0.6rem' }}>{title}</div>
      {children}
    </div>
  )
}

function Empty() {
  return <div className="empty-state"><div className="empty-state-icon">◌</div><div className="empty-state-title">No data for this period</div></div>
}
