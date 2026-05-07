// src/pages/WhatsAppQuotes.tsx — v2.7 real WhatsApp quotes module.
//
// Operators build a line-item quote against a contact, save as draft, then
// "Send" — which queues a WhatsApp template message via Q_WA_OUT (template
// `quote_summary` must be approved by Meta in the WhatsApp Business Manager
// for this to leave Cloudflare; if not approved, the send is queued and the
// failure surfaces in the Logs page DLQ row).

import React, { useEffect, useMemo, useState } from 'react'
import { quotesApi, type Quote, type QuoteLineItem } from '@/api/quotes'
import { contactsApi, type Contact } from '@/api/contacts'
import { useApp } from '@/context/AppContext'

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '0.45rem 0.55rem',
  fontFamily: 'var(--font-mono)', fontSize: '0.82rem',
  background: 'var(--bg-base)', color: 'var(--text-primary)',
  border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
}

function fmt(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`
}

const STATUSES: Quote['status'][] = ['draft','sent','accepted','declined','expired']

export default function WhatsAppQuotes() {
  const { showToast } = useApp()
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'any' | Quote['status']>('any')
  const [editor, setEditor] = useState<null | { mode: 'new' | 'edit'; quote?: Quote }>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const r = await quotesApi.list(statusFilter === 'any' ? undefined : { status: statusFilter })
      setQuotes(r.quotes)
    } catch (e) {
      showToast({ type: 'error', title: 'Load failed', message: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [statusFilter]) // eslint-disable-line

  const onSend = async (q: Quote) => {
    if (!confirm(`Send quote ${q.quote_number} via WhatsApp to ${q.contact?.name ?? q.contact_id}?`)) return
    try {
      await quotesApi.send(q.id)
      showToast({ type: 'success', title: 'Quote queued', message: `${q.quote_number} → wa-out` })
      await refresh()
    } catch (e) {
      showToast({ type: 'error', title: 'Send failed', message: (e as Error).message })
    }
  }

  const onStatus = async (q: Quote, status: 'accepted'|'declined'|'expired') => {
    try {
      await quotesApi.setStatus(q.id, status)
      showToast({ type: 'success', title: `Marked ${status}` })
      await refresh()
    } catch (e) {
      showToast({ type: 'error', title: 'Update failed', message: (e as Error).message })
    }
  }

  const onDelete = async (q: Quote) => {
    if (!confirm(`Delete draft ${q.quote_number}?`)) return
    try {
      await quotesApi.delete(q.id)
      showToast({ type: 'success', title: 'Deleted' })
      await refresh()
    } catch (e) {
      showToast({ type: 'error', title: 'Delete failed', message: (e as Error).message })
    }
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.85rem', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>WhatsApp Quotes</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Build a quote, send it through your approved <code>quote_summary</code> template, and track acceptance.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditor({ mode: 'new' })}>+ New Quote</button>
      </div>

      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.85rem' }}>
        <button className={`btn btn-sm ${statusFilter === 'any' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setStatusFilter('any')}>All</button>
        {STATUSES.map((s) => (
          <button key={s} className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setStatusFilter(s)}>{s}</button>
        ))}
      </div>

      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div> : quotes.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">◐</div>
          <div className="empty-state-title">No quotes</div>
          <div className="empty-state-body">Click "+ New Quote" to draft one.</div>
        </div>
      ) : (
        <table>
          <thead><tr>
            <th>Number</th><th>Contact</th><th>Total</th><th>Status</th><th>Created</th><th>Sent</th><th></th>
          </tr></thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td className="td-mono">{q.quote_number}</td>
                <td>{q.contact?.name ?? q.contact_id}<br/><span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{q.contact?.phone ?? ''}</span></td>
                <td className="td-mono">{fmt(q.total_cents, q.currency)}</td>
                <td><span className={`badge badge-${
                  q.status === 'accepted' ? 'green' :
                  q.status === 'declined' ? 'red' :
                  q.status === 'expired' ? 'gray' :
                  q.status === 'sent' ? 'blue' : 'yellow'}`}>{q.status}</span></td>
                <td className="td-mono text-xs">{new Date(q.created_at).toLocaleDateString()}</td>
                <td className="td-mono text-xs">{q.sent_at ? new Date(q.sent_at).toLocaleDateString() : '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: '0.3rem' }}>
                    {q.status === 'draft' && <button className="btn btn-ghost btn-sm" onClick={() => setEditor({ mode: 'edit', quote: q })}>Edit</button>}
                    {q.status === 'draft' && <button className="btn btn-secondary btn-sm" onClick={() => onSend(q)}>Send</button>}
                    {q.status === 'sent'  && <button className="btn btn-ghost btn-sm" onClick={() => onStatus(q, 'accepted')}>Accept</button>}
                    {q.status === 'sent'  && <button className="btn btn-ghost btn-sm" onClick={() => onStatus(q, 'declined')}>Decline</button>}
                    {q.status === 'sent'  && <button className="btn btn-ghost btn-sm" onClick={() => onStatus(q, 'expired')}>Expire</button>}
                    {q.status === 'draft' && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => onDelete(q)}>Delete</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editor && <QuoteEditor mode={editor.mode} initial={editor.quote} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); refresh() }} />}
    </div>
  )
}

// ── Editor modal (search a contact, edit line items, save / send) ───────────

function QuoteEditor({ mode, initial, onClose, onSaved }:
  { mode: 'new' | 'edit'; initial?: Quote; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useApp()
  const [contact, setContact] = useState<Contact | null>(null)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Contact[]>([])
  const [items, setItems] = useState<QuoteLineItem[]>(initial?.line_items ?? [])
  const [notes, setNotes] = useState<string>(initial?.notes ?? '')
  const [currency, setCurrency] = useState<string>(initial?.currency ?? 'USD')
  const [taxCents, setTaxCents] = useState<number>(initial?.tax_cents ?? 0)
  const [busy, setBusy] = useState(false)

  // Hydrate contact when editing.
  useEffect(() => {
    if (initial?.contact_id) {
      contactsApi.get(initial.contact_id).then(setContact).catch(() => null)
    }
  }, [initial?.contact_id])

  // Search contacts on type.
  useEffect(() => {
    if (mode !== 'new' || !search.trim()) { setResults([]); return }
    const t = setTimeout(async () => {
      try {
        const r = await contactsApi.list({ search, per_page: 10 })
        setResults(r.contacts)
      } catch { /* ignore */ }
    }, 250)
    return () => clearTimeout(t)
  }, [search, mode])

  const subtotal = useMemo(() => items.reduce((s, i) => s + (Number.isFinite(i.total_cents) ? i.total_cents : 0), 0), [items])
  const total = subtotal + (Number.isFinite(taxCents) ? taxCents : 0)

  const setItem = (idx: number, patch: Partial<QuoteLineItem>) => {
    setItems((arr) => arr.map((it, i) => {
      if (i !== idx) return it
      const next = { ...it, ...patch }
      const qty = Number.isFinite(next.qty) ? next.qty : 0
      const unit = Number.isFinite(next.unit_cents) ? next.unit_cents : 0
      next.total_cents = qty * unit
      return next
    }))
  }
  const addItem = () => setItems((arr) => [...arr, { description: '', qty: 1, unit_cents: 0, total_cents: 0 }])
  const removeItem = (idx: number) => setItems((arr) => arr.filter((_, i) => i !== idx))

  const save = async (sendAfter: boolean) => {
    const target = contact ?? (initial?.contact_id ? { id: initial.contact_id } as Contact : null)
    if (!target) { showToast({ type: 'error', title: 'Pick a contact' }); return }
    if (items.length === 0) { showToast({ type: 'error', title: 'Add at least one line item' }); return }
    setBusy(true)
    try {
      const payload = { contact_id: target.id, line_items: items, notes, currency, tax_cents: taxCents }
      const saved = mode === 'new' ? await quotesApi.create(payload) : await quotesApi.update(initial!.id, payload)
      if (sendAfter) {
        await quotesApi.send(saved.id)
        showToast({ type: 'success', title: 'Saved + sent' })
      } else {
        showToast({ type: 'success', title: 'Saved' })
      }
      onSaved()
    } catch (e) {
      showToast({ type: 'error', title: 'Save failed', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(880px, 100vw)' }}>
        <div className="modal-header">
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {mode === 'new' ? 'New quote' : `Edit ${initial?.quote_number ?? ''}`}
          </h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ marginBottom: '0.85rem' }}>
            <div className="section-label">Contact</div>
            {contact ? (
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', padding: '0.5rem', background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontFamily: 'var(--font-display)' }}>{contact.name}</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{contact.whatsapp_phone ?? contact.phone ?? '(no WA phone)'}</span>
                {mode === 'new' && <button className="btn btn-ghost btn-sm" onClick={() => setContact(null)}>Change</button>}
              </div>
            ) : (
              <>
                <input style={inputStyle} placeholder="Search contacts…" value={search} onChange={(e) => setSearch(e.target.value)} />
                {results.length > 0 && (
                  <div style={{ marginTop: '0.4rem', maxHeight: 200, overflow: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                    {results.map((r) => (
                      <button key={r.id} className="btn btn-ghost"
                              style={{ width: '100%', textAlign: 'left', borderRadius: 0, justifyContent: 'flex-start' }}
                              onClick={() => { setContact(r); setSearch(''); setResults([]) }}>
                        {r.name} · <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.whatsapp_phone ?? r.phone ?? '—'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="section-label">Line items</div>
          <table>
            <thead><tr>
              <th>Description</th><th style={{ width: 80 }}>Qty</th>
              <th style={{ width: 110 }}>Unit ({currency})</th><th style={{ width: 110 }}>Total</th><th style={{ width: 60 }}></th>
            </tr></thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={5} style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '0.85rem' }}>No items yet</td></tr>
              ) : items.map((it, i) => (
                <tr key={i}>
                  <td><input style={inputStyle} value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="e.g. CAT 320 hydraulic pump rebuild" /></td>
                  <td><input style={inputStyle} type="number" min={0} value={it.qty} onChange={(e) => setItem(i, { qty: parseFloat(e.target.value) || 0 })} /></td>
                  <td><input style={inputStyle} type="number" min={0} step="0.01" value={(it.unit_cents/100).toFixed(2)} onChange={(e) => setItem(i, { unit_cents: Math.round((parseFloat(e.target.value) || 0) * 100) })} /></td>
                  <td className="td-mono">{fmt(it.total_cents, currency)}</td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => removeItem(i)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: '0.4rem' }} onClick={addItem}>+ Add line item</button>

          <div style={{ marginTop: '0.85rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
            <Field label="Currency"><input style={inputStyle} value={currency} onChange={(e) => setCurrency(e.target.value)} /></Field>
            <Field label={`Tax (${currency})`}><input style={inputStyle} type="number" min={0} step="0.01" value={(taxCents/100).toFixed(2)} onChange={(e) => setTaxCents(Math.round((parseFloat(e.target.value) || 0) * 100))} /></Field>
          </div>
          <Field label="Notes">
            <textarea style={{ ...inputStyle, minHeight: 80 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <div style={{ marginTop: '0.6rem', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
            <div>Subtotal: {fmt(subtotal, currency)}</div>
            <div>Tax: {fmt(taxCents, currency)}</div>
            <div style={{ fontSize: '1.1rem', color: 'var(--accent)', fontWeight: 600 }}>Total: {fmt(total, currency)}</div>
          </div>
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => save(false)}>Save draft</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => save(true)}>Save & send</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: '0.6rem' }}>
      <div className="section-label">{label}</div>
      {children}
    </div>
  )
}
