// src/pages/LeadIntelligence.tsx
// Phase 4 — lead-intelligence dashboard + ranked-leads table.
// Routes: /leads (sub-routed):
//   /leads               → intelligence dashboard
//   /leads/ranked        → all leads, sorted by score

import React, { useEffect, useState, useCallback } from 'react'
import { Routes, Route, NavLink, Link, useNavigate, useLocation } from 'react-router-dom'
import { leadsApi, type LeadIntelligence as Intel, type RankedLead } from '@/api/leads'
import { useApp } from '@/context/AppContext'

const TABS = [
  { path: '',       label: 'Intelligence' },
  { path: 'ranked', label: 'All Leads' },
]

export default function LeadIntelligence() {
  return (
    <div style={{ padding: '1.5rem', maxWidth: 1180 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Lead Intelligence</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Rule-based scoring across engagement, demographics, behavior, and tags.</p>
        </div>
      </div>

      <nav style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border-default)', marginBottom: '1.25rem' }}>
        {TABS.map((t) => (
          <NavLink key={t.path} to={t.path} end={t.path === ''}
            style={({ isActive }) => ({
              padding: '0.55rem 0.85rem',
              fontFamily: 'var(--font-display)', fontSize: '0.78rem',
              letterSpacing: '0.06em', textTransform: 'uppercase',
              textDecoration: 'none',
              color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
              marginBottom: '-1px',
            })}>{t.label}</NavLink>
        ))}
      </nav>

      <Routes>
        <Route path=""       element={<IntelligencePanel />} />
        <Route path="ranked" element={<RankedPanel />} />
      </Routes>
    </div>
  )
}

// ── Intelligence dashboard ────────────────────────────────────────────────

function IntelligencePanel() {
  const { showToast } = useApp()
  const [intel, setIntel] = useState<Intel | null>(null)
  const [loading, setLoading] = useState(true)
  const [recalculating, setRecalculating] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setIntel(await leadsApi.intelligence()) }
    catch (e) { showToast({ type: 'error', title: 'Load failed', message: (e as Error).message }) }
    finally  { setLoading(false) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh() }, [refresh])

  const recalculate = async () => {
    setRecalculating(true)
    try {
      const r = await leadsApi.recalculateAll()
      showToast({ type: 'success', title: `Recalculated ${r.updated} leads` })
      await refresh()
    } catch (e) {
      showToast({ type: 'error', title: 'Recalculation failed', message: (e as Error).message })
    } finally {
      setRecalculating(false)
    }
  }

  if (loading || !intel) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>

  const Tile = ({ label, value, color }: { label: string; value: number; color: string }) => (
    <div style={{
      padding: '1.1rem 1.25rem',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-lg)',
      flex: 1, minWidth: 160,
    }}>
      <div style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '2rem', fontFamily: 'var(--font-display)', color, marginTop: '0.25rem' }}>{value.toLocaleString()}</div>
    </div>
  )

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.85rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={recalculate} disabled={recalculating}>
          {recalculating ? 'Recalculating…' : 'Recalculate All'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '0.85rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <Tile label="Total leads"  value={intel.counts.total} color="var(--text-primary)" />
        <Tile label="Hot leads"    value={intel.counts.hot}   color="var(--red)" />
        <Tile label="Warm leads"   value={intel.counts.warm}  color="var(--accent)" />
        <Tile label="Cold leads"   value={intel.counts.cold}  color="var(--blue)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '1rem' }}>
        <LeadList title="Top hot leads"   tone="var(--red)"    leads={intel.top_hot} />
        <LeadList title="Top warm leads"  tone="var(--accent)" leads={intel.top_warm} />
        <ScoringCard weights={intel.weights} />
      </div>
    </div>
  )
}

function LeadList({ title, tone, leads }: { title: string; tone: string; leads: Intel['top_hot'] }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: '1rem 1.1rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.85rem', color: tone, marginBottom: '0.6rem' }}>{title}</div>
      {leads.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No leads in this tier yet.</div>
      ) : (
        <table>
          <thead><tr><th>Name</th><th>Score</th><th>Country</th><th>Industry</th></tr></thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.contact_id}>
                <td><Link to={`/contacts/${l.contact_id}`} style={{ color: 'var(--text-primary)' }}>{l.name}</Link></td>
                <td className="td-mono" style={{ fontWeight: 600 }}>{l.score}</td>
                <td className="td-mono">{l.country_code ?? '—'}</td>
                <td className="td-mono">{l.industry ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ScoringCard({ weights }: { weights: Intel['weights'] }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: '1rem 1.1rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.85rem', color: 'var(--accent)', marginBottom: '0.6rem' }}>Scoring weights</div>
      {[
        { label: 'Engagement (opens, clicks, replies)', val: weights.engagement },
        { label: 'Demographics (country tier, industry)', val: weights.demographics },
        { label: 'Behavioral (visits, recent activity)', val: weights.behavioral },
        { label: 'Tags (investor, buyer, dealer …)',     val: weights.tags },
      ].map((w) => (
        <div key={w.label} style={{ marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', marginBottom: '0.2rem', color: 'var(--text-secondary)' }}>
            <span>{w.label}</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{w.val}%</span>
          </div>
          <div style={{ height: 6, background: 'var(--bg-base)', borderRadius: 999 }}>
            <div style={{ width: `${w.val}%`, height: '100%', background: 'var(--accent)', borderRadius: 999 }} />
          </div>
        </div>
      ))}
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.85rem' }}>
        Hot ≥ 80, warm ≥ 50, cold &lt; 50.
      </div>
    </div>
  )
}

// ── Ranked panel ──────────────────────────────────────────────────────────

function RankedPanel() {
  const navigate = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const cat = (params.get('category') ?? 'all') as 'all' | 'hot' | 'warm' | 'cold'
  const page = parseInt(params.get('page') ?? '1', 10)

  const [rows, setRows] = useState<RankedLead[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    leadsApi.ranked({ page, per_page: 50, category: cat })
      .then((r) => { setRows(r.leads); setTotal(r.total) })
      .finally(() => setLoading(false))
  }, [page, cat])

  const setCat = (c: typeof cat) => {
    const next = new URLSearchParams(location.search)
    if (c === 'all') next.delete('category'); else next.set('category', c)
    next.set('page', '1')
    navigate(`?${next.toString()}`)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.85rem' }}>
        {(['all','hot','warm','cold'] as const).map((c) => (
          <button key={c} onClick={() => setCat(c)} className={`btn ${cat === c ? 'btn-primary' : 'btn-ghost'} btn-sm`}>
            {c.toUpperCase()}
          </button>
        ))}
      </div>
      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div> : (
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Score</th><th>Tier</th><th>Engagement</th>
              <th>Country</th><th>Industry</th><th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7}><div className="empty-state"><div className="empty-state-icon">◌</div><div className="empty-state-title">No leads scored yet</div><div className="empty-state-body">Click "Recalculate All" on the Intelligence tab.</div></div></td></tr>
            ) : rows.map((l) => (
              <tr key={l.contact_id}>
                <td><Link to={`/contacts/${l.contact_id}`} style={{ color: 'var(--text-primary)' }}>{l.name}</Link></td>
                <td className="td-mono" style={{ fontWeight: 600, color: l.category === 'hot' ? 'var(--red)' : l.category === 'warm' ? 'var(--accent)' : 'var(--blue)' }}>{l.score}</td>
                <td><span className={`badge badge-${l.category === 'hot' ? 'red' : l.category === 'warm' ? 'yellow' : 'blue'}`}>{l.category}</span></td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <div style={{ width: 80, height: 6, background: 'var(--bg-base)', borderRadius: 999 }}>
                      <div style={{ width: `${Math.min(100, (l.engagement / 35) * 100)}%`, height: '100%', background: 'var(--accent)', borderRadius: 999 }} />
                    </div>
                    <span className="td-mono" style={{ fontSize: '0.75rem' }}>{l.engagement}</span>
                  </div>
                </td>
                <td className="td-mono">{l.country ?? '—'}</td>
                <td className="td-mono">{l.industry ?? '—'}</td>
                <td>{l.tags.slice(0, 3).map((t) => <span key={t} className="badge badge-ghost" style={{ marginRight: 4 }}>{t}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ marginTop: '0.75rem', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
        {total.toLocaleString()} total
      </div>
    </div>
  )
}
