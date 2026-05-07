// src/pages/RegionalOutreach.tsx — Phase 5 Middle East regional dashboard.

import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { leadsApi, type RankedLead } from '@/api/leads'
import { setLocale, getLocale, t, isRtl } from '@/i18n'

const TIER1 = ['SA', 'AE', 'KW']
const TIER2 = ['EG', 'BH', 'OM', 'QA']
const ALL_ME = [...TIER1, ...TIER2]
const INDUSTRIES = ['construction', 'oil_gas', 'heavy_equipment', 'equipment_dealers']

export default function RegionalOutreach() {
  const [leads, setLeads] = useState<RankedLead[]>([])
  const [loading, setLoading] = useState(true)
  const [country, setCountry] = useState<string>('all')
  const [industry, setIndustry] = useState<string>('all')
  const [, force] = useState(0)
  const [locale, setLocaleState] = useState(getLocale())

  useEffect(() => {
    const handler = () => { setLocaleState(getLocale()); force((n) => n + 1) }
    window.addEventListener('icrv:locale-changed', handler)
    return () => window.removeEventListener('icrv:locale-changed', handler)
  }, [])

  useEffect(() => {
    setLoading(true)
    leadsApi.ranked({ page: 1, per_page: 200 })
      .then((r) => setLeads(r.leads))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => leads.filter((l) => {
    if (country === 'all' && industry === 'all') return ALL_ME.includes(l.country ?? '')
    if (country === 'tier1') return TIER1.includes(l.country ?? '') && (industry === 'all' || l.industry === industry)
    if (country === 'tier2') return TIER2.includes(l.country ?? '') && (industry === 'all' || l.industry === industry)
    if (country === 'other_me') return ALL_ME.includes(l.country ?? '') && industry === 'all'
    if (country !== 'all' && l.country !== country) return false
    if (industry !== 'all' && l.industry !== industry) return false
    return true
  }), [leads, country, industry])

  const counts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const l of leads) {
      if (!l.country) continue
      map[l.country] = (map[l.country] ?? 0) + 1
    }
    return map
  }, [leads])

  const dirAttr = isRtl(locale) ? 'rtl' : 'ltr'

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1280 }} dir={dirAttr}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.85rem', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{t('regional.title')}</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('regional.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button className={`btn btn-sm ${locale === 'en' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setLocale('en')}>EN</button>
          <button className={`btn btn-sm ${locale === 'ar' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setLocale('ar')}>عربي</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.6rem', marginBottom: '1.25rem' }}>
        {[{ key: 'all', label: t('regional.all') }, ...TIER1.map((c) => ({ key: c, label: t(`regional.country.${c}`) })), ...TIER2.map((c) => ({ key: c, label: t(`regional.country.${c}`) })), { key: 'other_me', label: t('regional.other_me') }].map((tile) => (
          <button key={tile.key} onClick={() => setCountry(tile.key)} style={{
            padding: '0.85rem 1rem',
            background: country === tile.key ? 'var(--accent-glow)' : 'var(--bg-surface)',
            border: `1px solid ${country === tile.key ? 'var(--accent)' : 'var(--border-default)'}`,
            color: country === tile.key ? 'var(--accent)' : 'var(--text-primary)',
            borderRadius: 'var(--radius-lg)',
            cursor: 'pointer', textAlign: dirAttr === 'rtl' ? 'right' : 'left',
            fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.78rem',
          }}>
            <div>{tile.label}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.4rem', marginTop: '0.25rem' }}>{counts[tile.key] ?? (tile.key === 'all' ? leads.filter((l) => ALL_ME.includes(l.country ?? '')).length : 0)}</div>
          </button>
        ))}
      </div>

      <div style={{ marginBottom: '0.85rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        <button className={`btn btn-sm ${industry === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setIndustry('all')}>All industries</button>
        {INDUSTRIES.map((ind) => (
          <button key={ind} onClick={() => setIndustry(ind)} className={`btn btn-sm ${industry === ind ? 'btn-primary' : 'btn-ghost'}`}>
            {t(`regional.industry.${ind}`)}
          </button>
        ))}
      </div>

      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div> : filtered.length === 0 ? (
        <div className="empty-state"><div className="empty-state-icon">◌</div><div className="empty-state-title">{t('regional.no_leads')}</div></div>
      ) : (
        <table>
          <thead><tr>
            <th>{t('common.name')}</th><th>{t('common.email')}</th><th>{t('common.country')}</th><th>{t('common.industry')}</th><th>{t('common.score')}</th><th>{t('common.tier')}</th>
          </tr></thead>
          <tbody>
            {filtered.map((l) => (
              <tr key={l.contact_id}>
                <td><Link to={`/contacts/${l.contact_id}`} style={{ color: 'var(--text-primary)' }}>{l.name}</Link></td>
                <td className="td-mono">{l.email ?? '—'}</td>
                <td className="td-mono">{l.country ? t(`regional.country.${l.country}`, l.country) : '—'}</td>
                <td className="td-mono">{l.industry ? t(`regional.industry.${l.industry}`, l.industry) : '—'}</td>
                <td className="td-mono" style={{ fontWeight: 600 }}>{l.score}</td>
                <td>{TIER1.includes(l.country ?? '') ? <span className="badge badge-accent">{t('regional.tier1')}</span> : TIER2.includes(l.country ?? '') ? <span className="badge badge-blue">{t('regional.tier2')}</span> : <span className="badge badge-ghost">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
