// src/pages/Templates.tsx — Phase 5 templates library.
// Visual cards, sandboxed iframe preview, basic editor with variable picker.

import React, { useEffect, useMemo, useState } from 'react'
import { campaignsApi, type Template, type CampaignChannel } from '@/api/campaigns'
import { useApp } from '@/context/AppContext'

const VARIABLES = [
  '{{contact.name}}', '{{contact.email}}', '{{contact.phone}}',
  '{{contact.country}}', '{{contact.industry}}',
  '{{campaign.name}}', '{{workspace.company}}',
  '{{unsubscribe_url}}',
]

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '0.5rem 0.6rem',
  fontFamily: 'var(--font-mono)', fontSize: '0.82rem',
  background: 'var(--bg-base)', color: 'var(--text-primary)',
  border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
}

export default function Templates() {
  const { showToast } = useApp()
  const [items, setItems] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('')
  const [editing, setEditing] = useState<Partial<Template> | null>(null)

  const refresh = async () => {
    setLoading(true)
    try { setItems((await campaignsApi.listTemplates()).templates) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])

  const tags = useMemo(() => {
    const all = new Set<string>()
    for (const t of items) (t.tags ?? []).forEach((tag) => all.add(tag))
    return Array.from(all)
  }, [items])

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    return items.filter((t) => {
      if (s && !t.name.toLowerCase().includes(s) && !(t.subject ?? '').toLowerCase().includes(s)) return false
      if (tagFilter && !(t.tags ?? []).includes(tagFilter)) return false
      return true
    })
  }, [items, search, tagFilter])

  const save = async () => {
    if (!editing || !editing.name || !editing.channel) {
      showToast({ type: 'error', title: 'Name and channel required' })
      return
    }
    try {
      if (editing.id) {
        await campaignsApi.updateTemplate(editing.id, editing)
      } else {
        await campaignsApi.createTemplate({
          name: editing.name,
          channel: editing.channel as CampaignChannel,
          subject: editing.subject,
          body_html: editing.body_html,
          body_text: editing.body_text,
          tags: editing.tags,
        })
      }
      setEditing(null)
      await refresh()
      showToast({ type: 'success', title: 'Template saved' })
    } catch (e) {
      showToast({ type: 'error', title: 'Save failed', message: (e as Error).message })
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this template?')) return
    await campaignsApi.deleteTemplate(id)
    refresh()
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1280 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.85rem', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Templates</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Reusable email / WhatsApp / voice content with variable interpolation.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input style={{ ...inputStyle, width: 220 }} placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({ name: '', channel: 'email', body_html: '<p>Hi {{contact.name}}!</p>', tags: [] })}>+ New Template</button>
        </div>
      </div>

      {tags.length > 0 && (
        <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <button className={`btn btn-sm ${tagFilter === '' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTagFilter('')}>All</button>
          {tags.map((t) => (
            <button key={t} className={`btn btn-sm ${tagFilter === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTagFilter(t)}>{t}</button>
          ))}
        </div>
      )}

      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div> : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">▤</div>
          <div className="empty-state-title">No templates</div>
          <div className="empty-state-body">Click "+ New Template" to create one.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.85rem' }}>
          {filtered.map((t) => (
            <div key={t.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: '0.85rem', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.95rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t.name}</div>
                <span className={`badge badge-${t.channel === 'email' ? 'blue' : t.channel === 'whatsapp' ? 'green' : 'purple'}`}>{t.channel}</span>
              </div>
              {t.subject && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>{t.subject}</div>}
              <iframe sandbox="" srcDoc={t.body_html ?? '<p>(empty)</p>'}
                      style={{ width: '100%', height: 140, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: '#fff' }} />
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem', justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(t)}>Edit</button>
                <button className="btn btn-ghost btn-sm" onClick={() => remove(t.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal" style={{ width: 'min(900px, 100vw)' }}>
            <div className="modal-header">
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {editing.id ? 'Edit template' : 'New template'}
              </h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setEditing(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
                <input style={inputStyle} placeholder="Name" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <select style={inputStyle} value={editing.channel ?? 'email'} onChange={(e) => setEditing({ ...editing, channel: e.target.value as CampaignChannel })}>
                  <option value="email">email</option>
                  <option value="whatsapp">whatsapp</option>
                  <option value="voice">voice</option>
                </select>
              </div>
              {editing.channel === 'email' && (
                <input style={{ ...inputStyle, marginBottom: '0.5rem' }} placeholder="Subject" value={editing.subject ?? ''} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <div className="section-label">Body (HTML)</div>
                  <textarea
                    id="tpl-body"
                    style={{ ...inputStyle, minHeight: 240, fontSize: '0.78rem' }}
                    value={editing.body_html ?? ''}
                    onChange={(e) => setEditing({ ...editing, body_html: e.target.value })}
                  />
                  <div style={{ marginTop: '0.4rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                    {VARIABLES.map((v) => (
                      <button key={v} className="btn btn-ghost btn-sm" onClick={() => {
                        const ta = document.getElementById('tpl-body') as HTMLTextAreaElement | null
                        if (!ta) return
                        const start = ta.selectionStart, end = ta.selectionEnd
                        const before = (editing.body_html ?? '').slice(0, start)
                        const after  = (editing.body_html ?? '').slice(end)
                        setEditing({ ...editing, body_html: before + v + after })
                        setTimeout(() => { ta.focus(); ta.selectionEnd = start + v.length }, 10)
                      }}>{v}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="section-label">Preview</div>
                  <iframe sandbox="" srcDoc={editing.body_html ?? ''} style={{ width: '100%', height: 270, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: '#fff' }} />
                </div>
              </div>
              <div style={{ marginTop: '0.75rem' }}>
                <div className="section-label">Tags (comma-separated)</div>
                <input style={inputStyle}
                       value={(editing.tags ?? []).join(', ')}
                       onChange={(e) => setEditing({ ...editing, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
