// src/pages/Contacts.tsx
// Full contacts module: list, create, edit, delete, CSV/XLSX bulk upload

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { contactsApi, type Contact, type ContactCreatePayload, type BulkUploadResponse, type UploadJobStatus } from '@/api/contacts'
import { useApp } from '@/context/AppContext'
import { formatDistanceToNow } from 'date-fns'
import { ConfirmModal } from '@/components/ConfirmModal'

// ── Contact Form Modal ────────────────────────────────────────────────────────

interface ContactFormProps {
  contact?: Contact
  onClose: () => void
  onSaved: () => void
}

function ContactForm({ contact, onClose, onSaved }: ContactFormProps) {
  const { showToast } = useApp()
  const [form, setForm] = useState<ContactCreatePayload>({
    name:             contact?.name ?? '',
    email:            contact?.email ?? '',
    phone:            contact?.phone ?? '',
    whatsapp_phone:   contact?.whatsapp_phone ?? '',
    consent_email:    contact?.consent_email ?? false,
    consent_whatsapp: contact?.consent_whatsapp ?? false,
    consent_voice:    contact?.consent_voice ?? false,
    tags:             contact?.tags ?? [],
  })
  const [saving, setSaving] = useState(false)
  const [tagInput, setTagInput] = useState('')

  const set = (k: keyof ContactCreatePayload, v: unknown) =>
    setForm((prev) => ({ ...prev, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    try {
      if (contact) {
        await contactsApi.update(contact.id, form)
        showToast({ type: 'success', title: 'Contact updated', message: form.name })
      } else {
        await contactsApi.create(form)
        showToast({ type: 'success', title: 'Contact created', message: form.name })
      }
      onSaved()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      showToast({ type: 'error', title: 'Error', message: msg })
    } finally {
      setSaving(false)
    }
  }

  const addTag = () => {
    const t = tagInput.trim().toLowerCase()
    if (t && !form.tags?.includes(t)) {
      set('tags', [...(form.tags ?? []), t])
      setTagInput('')
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {contact ? 'Edit Contact' : 'New Contact'}
          </h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input className="form-control" value={form.name} onChange={(e) => set('name', e.target.value)} required placeholder="Jane Smith" />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Email Address</label>
                  <input className="form-control" type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="jane@example.com" />
                </div>
                <div className="form-group">
                  <label className="form-label">Phone (E.164)</label>
                  <input className="form-control" value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="+15551234567" />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">WhatsApp Number (E.164)</label>
                <input className="form-control" value={form.whatsapp_phone ?? ''} onChange={(e) => set('whatsapp_phone', e.target.value)} placeholder="+15551234567" />
              </div>

              {/* Consent */}
              <div>
                <div className="section-label">Consent Status</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {(['email', 'whatsapp', 'voice'] as const).map((ch) => (
                    <label key={ch} className="toggle-wrap">
                      <span className="toggle">
                        <input
                          type="checkbox"
                          checked={form[`consent_${ch}` as keyof ContactCreatePayload] as boolean ?? false}
                          onChange={(e) => set(`consent_${ch}` as keyof ContactCreatePayload, e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                        {ch} consent
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Tags */}
              <div className="form-group">
                <label className="form-label">Tags</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    className="form-control"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                    placeholder="Add tag..."
                  />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addTag}>+ Add</button>
                </div>
                {(form.tags?.length ?? 0) > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.5rem' }}>
                    {form.tags!.map((t) => (
                      <span
                        key={t}
                        className="badge badge-gray"
                        style={{ cursor: 'pointer' }}
                        onClick={() => set('tags', form.tags!.filter((x) => x !== t))}
                      >
                        {t} ✕
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : contact ? 'Save Changes' : 'Create Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Bulk Upload Modal ─────────────────────────────────────────────────────────

// PR 5 / H6 guardrails: refuse the upload client-side before we send the file.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_UPLOAD_ROWS  = 50_000
// PR 5 / H7: bulk-upload poll caps out — beyond this the modal closes and the
// user is steered to the Logs page so the dashboard never deadlocks on a
// stalled job.
const MAX_POLL_MS = 5 * 60 * 1000

function BulkUploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { showToast } = useApp()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string[][]>([])
  const [uploading, setUploading] = useState(false)
  const [jobStatus, setJobStatus] = useState<UploadJobStatus | null>(null)
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleFile = async (f: File) => {
    if (f.size > MAX_UPLOAD_BYTES) {
      showToast({
        type: 'error',
        title: 'File too large',
        message: `Max ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB — got ${(f.size / 1024 / 1024).toFixed(1)} MB`,
      })
      return
    }
    const ext = (f.name.split('.').pop() ?? '').toLowerCase()
    const isExcel = ext === 'xlsx' || ext === 'xls'
    if (isExcel) {
      try {
        const buf  = await f.arrayBuffer()
        const wb   = XLSX.read(buf, { type: 'array' })
        const ws   = wb.Sheets[wb.SheetNames[0]]
        const csv  = XLSX.utils.sheet_to_csv(ws)
        const rebuilt = new File([csv], f.name.replace(/\.(xlsx|xls)$/i, '.csv'), { type: 'text/csv' })
        if (rebuilt.size > MAX_UPLOAD_BYTES) {
          showToast({ type: 'error', title: 'File too large after conversion', message: 'Reduce rows and retry.' })
          return
        }
        // Recurse with the converted CSV.
        return handleFile(rebuilt)
      } catch (err) {
        showToast({ type: 'error', title: 'Excel parse error', message: (err as Error).message })
        return
      }
    }

    // Streaming row count via Papa.parse step callback — bails as soon as we
    // pass the cap so we don't materialise the whole file in memory.
    let rowCount = 0
    let aborted  = false
    Papa.parse<string[]>(f, {
      step: (_row, parser) => {
        rowCount++
        if (rowCount > MAX_UPLOAD_ROWS) {
          aborted = true
          parser.abort()
        }
      },
      complete: () => {
        if (aborted) {
          showToast({
            type: 'error',
            title: 'Too many rows',
            message: `Max ${MAX_UPLOAD_ROWS.toLocaleString()} rows — split the file and retry`,
          })
          return
        }
        setFile(f)
        // Re-parse a small preview now that we've validated the row count.
        Papa.parse<string[]>(f, {
          preview: 6,
          complete: (results) => setPreview(results.data as string[][]),
          error: () => showToast({ type: 'error', title: 'CSV Parse Error', message: 'Could not read file' }),
        })
      },
      error: () => showToast({ type: 'error', title: 'CSV Parse Error', message: 'Could not read file' }),
    })
  }

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (deadlineRef.current) { clearTimeout(deadlineRef.current); deadlineRef.current = null }
  }

  const upload = async () => {
    if (!file) return
    setUploading(true)
    try {
      const res: BulkUploadResponse = await contactsApi.bulkUpload(file)
      showToast({
        type: 'info',
        title: 'Upload queued',
        message: res.total_rows
          ? `Job ${res.job_id} — ${res.total_rows} rows`
          : `Job ${res.job_id} — processing in background`,
      })
      // Hard 5-minute deadline so a stuck job can't poll forever.
      deadlineRef.current = setTimeout(() => {
        stopPolling()
        showToast({
          type: 'info',
          title: 'Upload still processing',
          message: 'Check the Logs page for status.',
        })
        onClose()
      }, MAX_POLL_MS)

      pollRef.current = setInterval(async () => {
        const status = await contactsApi.getUploadJob(res.job_id)
        setJobStatus(status)
        if (status.status === 'completed' || status.status === 'failed') {
          stopPolling()
          if (status.status === 'completed') {
            showToast({ type: 'success', title: 'Upload complete', message: `${status.accepted} contacts imported` })
            onDone()
          } else {
            showToast({ type: 'error', title: 'Upload failed' })
          }
        }
      }, 3000)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      showToast({ type: 'error', title: 'Upload failed', message: msg })
    } finally {
      setUploading(false)
    }
  }

  useEffect(() => () => stopPolling(), [])

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Bulk Upload (CSV or Excel)
          </h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div
            style={{
              border: '2px dashed var(--border-strong)',
              borderRadius: 'var(--radius-lg)',
              padding: '2rem',
              textAlign: 'center',
              marginBottom: '1rem',
              cursor: 'pointer',
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            onClick={() => document.getElementById('csv-input')?.click()}
          >
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem', color: 'var(--text-muted)' }}>⇑</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.85rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
              {file ? file.name : 'Drop CSV or Excel file, or click to browse'}
            </div>
            <div className="text-xs text-muted" style={{ marginTop: '0.35rem' }}>
              Required columns: name, email, phone, whatsapp_phone, consent_email, consent_whatsapp, consent_voice
            </div>
            <input id="csv-input" type="file" accept=".csv,.tsv,.xlsx,.xls" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          </div>

          {preview.length > 0 && (
            <div>
              <div className="section-label">Preview (first {preview.length} rows)</div>
              <div className="table-wrap" style={{ maxHeight: '200px', overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>{preview[0]?.map((h, i) => <th key={i}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.slice(1).map((row, i) => (
                      <tr key={i}>{row.map((cell, j) => <td key={j} className="td-mono">{cell}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {jobStatus && (
            <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'var(--bg-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <span className="font-display text-xs">Job Status</span>
                <span className={`badge ${jobStatus.status === 'completed' ? 'badge-green' : jobStatus.status === 'failed' ? 'badge-red' : 'badge-yellow'}`}>{jobStatus.status}</span>
              </div>
              <div className="text-xs text-muted font-mono">
                Processed: {jobStatus.processed}/{jobStatus.total_rows} · Accepted: {jobStatus.accepted} · Rejected: {jobStatus.rejected}
              </div>
              {jobStatus.errors.length > 0 && (
                <div className="code-block" style={{ marginTop: '0.5rem', maxHeight: '100px' }}>
                  {jobStatus.errors.map((e, i) => `Row ${e.row}: ${e.reason}`).join('\n')}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={upload} disabled={!file || uploading}>
            {uploading ? 'Uploading…' : 'Upload CSV'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Contact Detail Panel ──────────────────────────────────────────────────────

function ContactDetail({ contact, onEdit, onDelete }: { contact: Contact; onEdit: () => void; onDelete: () => void }) {
  const { showToast } = useApp()
  const [deleting, setDeleting] = useState(false)
  // PR 7 / L5: type-to-confirm modal instead of the browser's native confirm().
  const [confirmOpen, setConfirmOpen] = useState(false)

  const performDelete = async () => {
    setDeleting(true)
    try {
      await contactsApi.delete(contact.id)
      showToast({ type: 'success', title: 'Contact deleted', message: contact.name })
      setConfirmOpen(false)
      onDelete()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Delete failed'
      showToast({ type: 'error', title: 'Error', message: msg })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="card" style={{ height: '100%' }}>
      <div className="card-header">
        <span className="card-title">Contact Profile</span>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={onEdit}>Edit</button>
          <button className="btn btn-danger btn-sm" onClick={() => setConfirmOpen(true)} disabled={deleting}>
            {deleting ? '…' : 'Delete'}
          </button>
          <ConfirmModal
            open={confirmOpen}
            title="Delete contact"
            body={`This permanently deletes ${contact.name} and any associated activity history. This cannot be undone.`}
            confirmWord="DELETE"
            confirmLabel="DELETE CONTACT"
            onConfirm={performDelete}
            onClose={() => setConfirmOpen(false)}
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)' }}>{contact.name}</div>
          <div className="text-xs font-mono text-muted">{contact.id}</div>
        </div>

        <div className="divider" />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {contact.email && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-xs font-display" style={{ color: 'var(--text-muted)' }}>Email</span>
              <span className="text-sm font-mono">{contact.email}</span>
            </div>
          )}
          {contact.phone && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-xs font-display" style={{ color: 'var(--text-muted)' }}>Phone</span>
              <span className="text-sm font-mono">{contact.phone}</span>
            </div>
          )}
          {contact.whatsapp_phone && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="text-xs font-display" style={{ color: 'var(--text-muted)' }}>WhatsApp</span>
              <span className="text-sm font-mono">{contact.whatsapp_phone}</span>
            </div>
          )}
        </div>

        <div className="divider" />

        <div>
          <div className="section-label">Consent</div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <span className={`badge ${contact.consent_email ? 'badge-green' : 'badge-gray'}`}>Email</span>
            <span className={`badge ${contact.consent_whatsapp ? 'badge-green' : 'badge-gray'}`}>WhatsApp</span>
            <span className={`badge ${contact.consent_voice ? 'badge-green' : 'badge-gray'}`}>Voice</span>
          </div>
        </div>

        {contact.tags.length > 0 && (
          <>
            <div className="divider" />
            <div>
              <div className="section-label">Tags</div>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                {contact.tags.map((t) => (
                  <span key={t} className="badge badge-accent">{t}</span>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="divider" />
        <div className="text-xs text-muted font-mono">
          Created {formatDistanceToNow(new Date(contact.created_at), { addSuffix: true })}
        </div>
      </div>
    </div>
  )
}

// ── Main Contacts Page ────────────────────────────────────────────────────────

import type { BulkFilter } from '@/api/contacts'

type ConsentStateFilter = 'any' | 'granted' | 'pending' | 'revoked' | 'never_requested'

interface ConsentSummary {
  total: number; granted: number; revoked: number; pending: number; never_requested: number
}

export default function Contacts() {
  const { showToast } = useApp()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [perPage] = useState(20)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Contact | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editContact, setEditContact] = useState<Contact | undefined>()
  const [showUpload, setShowUpload] = useState(false)

  // v2.6 — bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectAllMatching, setSelectAllMatching] = useState(false)
  const [consentFilter, setConsentFilter] = useState<ConsentStateFilter>('any')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkPrompt, setBulkPrompt] = useState<null | 'add_tag' | 'remove_tag' | 'set_field'>(null)
  const [promptValue, setPromptValue] = useState('')
  const [promptField, setPromptField] = useState<'country_code'|'industry'|'region_tier'|'country_name_ar'|'industry_ar'>('country_code')
  const [summary, setSummary] = useState<ConsentSummary | null>(null)

  const buildFilter = useCallback((): BulkFilter => {
    if (selectAllMatching) {
      return {
        search: search || undefined,
        consent_state: consentFilter === 'any' ? undefined : consentFilter,
        consent_channel: 'email',
      }
    }
    return { ids: Array.from(selectedIds) }
  }, [selectAllMatching, search, consentFilter, selectedIds])

  const selectedCount = selectAllMatching ? total : selectedIds.size

  const loadContacts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await contactsApi.list({
        page,
        per_page: perPage,
        search: search || undefined,
        consent_state: consentFilter === 'any' ? undefined : consentFilter,
        consent_channel: consentFilter === 'any' ? undefined : 'email',
      })
      setContacts(res.contacts)
      setTotal(res.total)
    } catch {
      // Error handled by interceptor
    } finally {
      setLoading(false)
    }
  }, [page, perPage, search, consentFilter])

  const refreshSummary = useCallback(async () => {
    try { setSummary(await contactsApi.consentSummary('email')) } catch { /* non-fatal */ }
  }, [])

  useEffect(() => { loadContacts(); refreshSummary() }, [loadContacts, refreshSummary])

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); loadContacts() }, 400)
    return () => clearTimeout(t)
  }, [search]) // eslint-disable-line

  // Clear selection + reset paging when filter or search shifts the row population.
  useEffect(() => { setSelectedIds(new Set()); setSelectAllMatching(false); setPage(1) }, [consentFilter])
  useEffect(() => { setSelectedIds(new Set()); setSelectAllMatching(false) }, [search])

  const toggleRow = (id: string) => {
    setSelectAllMatching(false)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const togglePage = () => {
    if (selectAllMatching) { setSelectAllMatching(false); setSelectedIds(new Set()); return }
    const allOnPageSelected = contacts.length > 0 && contacts.every((c) => selectedIds.has(c.id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) { for (const c of contacts) next.delete(c.id) }
      else                   { for (const c of contacts) next.add(c.id) }
      return next
    })
  }

  const clearSelection = () => { setSelectedIds(new Set()); setSelectAllMatching(false) }

  const runBulk = async (fn: () => Promise<{ affected: number }>, label: string) => {
    if (selectedCount === 0) return
    setBulkBusy(true)
    try {
      const r = await fn()
      showToast({ type: 'success', title: label, message: `${r.affected.toLocaleString()} contact${r.affected === 1 ? '' : 's'} updated` })
      clearSelection()
      await loadContacts(); await refreshSummary()
    } catch (e) {
      showToast({ type: 'error', title: `${label} failed`, message: (e as Error).message })
    } finally {
      setBulkBusy(false)
    }
  }

  const onBulkDelete = () => {
    if (selectedCount === 0) return
    if (!confirm(`Delete ${selectedCount.toLocaleString()} contact${selectedCount === 1 ? '' : 's'}? This cannot be undone.`)) return
    runBulk(() => contactsApi.bulk({ filter: buildFilter(), action: 'delete' }), 'Deleted')
  }

  const onAddTag = () => { setPromptValue(''); setBulkPrompt('add_tag') }
  const onRemoveTag = () => { setPromptValue(''); setBulkPrompt('remove_tag') }
  const onSetField = () => { setPromptValue(''); setPromptField('country_code'); setBulkPrompt('set_field') }
  const onMarkConsented = () => runBulk(
    () => contactsApi.bulk({ filter: buildFilter(), action: 'set_consent', params: { channel: 'email', state: 'granted' } }),
    'Marked consented',
  )
  const onMarkRevoked = () => runBulk(
    () => contactsApi.bulk({ filter: buildFilter(), action: 'set_consent', params: { channel: 'email', state: 'revoked' } }),
    'Marked revoked',
  )

  const submitPrompt = () => {
    const v = promptValue.trim()
    if (!v && bulkPrompt !== 'set_field') { showToast({ type: 'error', title: 'Tag required' }); return }
    if (bulkPrompt === 'add_tag') {
      runBulk(() => contactsApi.bulk({ filter: buildFilter(), action: 'add_tag', params: { tag: v } }), `Tag added: ${v}`)
    } else if (bulkPrompt === 'remove_tag') {
      runBulk(() => contactsApi.bulk({ filter: buildFilter(), action: 'remove_tag', params: { tag: v } }), `Tag removed: ${v}`)
    } else if (bulkPrompt === 'set_field') {
      runBulk(
        () => contactsApi.bulk({ filter: buildFilter(), action: 'set_field', params: { field: promptField, value: promptValue } }),
        `Set ${promptField}`,
      )
    }
    setBulkPrompt(null)
  }

  const sendConsent = async (onlyPending = false) => {
    const filter = onlyPending
      ? { consent_state: 'pending' as const, consent_channel: 'email' as const }
      : buildFilter()
    if (!onlyPending && selectedCount === 0) {
      showToast({ type: 'error', title: 'Select contacts first' })
      return
    }
    setBulkBusy(true)
    try {
      const r = await contactsApi.consentRequest({ filter, only_pending: onlyPending })
      const skipped = (r.skipped_no_email ?? 0)
      const message = skipped > 0
        ? `${r.requested} sent · ${skipped} skipped (no email on file)`
        : `${r.requested} sent`
      showToast({
        type: 'success',
        title: onlyPending ? 'Consent re-requests queued' : 'Consent requests queued',
        message,
      })
      clearSelection(); await refreshSummary()
    } catch (e) {
      showToast({ type: 'error', title: 'Send failed', message: (e as Error).message })
    } finally {
      setBulkBusy(false)
    }
  }

  const totalPages = Math.ceil(total / perPage)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Contacts</h1>
          <p className="page-subtitle">{total.toLocaleString()} total contacts in D1</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={() => setShowUpload(true)}>⇑ Bulk CSV</button>
          <button className="btn btn-primary" onClick={() => { setEditContact(undefined); setShowForm(true) }}>+ New Contact</button>
        </div>
      </div>

      {/* Consent summary panel */}
      {summary && (
        <div style={{
          display: 'flex', gap: '0.6rem', flexWrap: 'wrap',
          marginBottom: '0.85rem', padding: '0.75rem 1rem',
          background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)', alignItems: 'center',
        }}>
          <span style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Email consent:</span>
          <span className="badge badge-green">Consented {summary.granted.toLocaleString()}</span>
          <span className="badge badge-yellow">Pending {summary.pending.toLocaleString()}</span>
          <span className="badge badge-red">Revoked {summary.revoked.toLocaleString()}</span>
          <span className="badge badge-gray">Never asked {summary.never_requested.toLocaleString()}</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-secondary btn-sm" disabled={bulkBusy || summary.pending === 0}
                  onClick={() => sendConsent(true)}>
            Resend pending ({summary.pending.toLocaleString()})
          </button>
        </div>
      )}

      {/* Search + Filter bar */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="search-wrap">
          <span className="search-icon">⌕</span>
          <input
            className="form-control"
            placeholder="Search name, email, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select className="form-control" style={{ width: 200 }} value={consentFilter} onChange={(e) => setConsentFilter(e.target.value as ConsentStateFilter)}>
          <option value="any">All consent states</option>
          <option value="granted">Consented</option>
          <option value="pending">Awaiting consent</option>
          <option value="revoked">Revoked</option>
          <option value="never_requested">Never requested</option>
        </select>
        <span className="text-xs text-muted">
          {contacts.length} shown · {total.toLocaleString()} total
        </span>
      </div>

      {/* Bulk action toolbar */}
      {selectedCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
          marginBottom: '0.85rem', padding: '0.6rem 0.85rem',
          background: 'var(--accent-glow)', border: '1px solid var(--accent)',
          borderRadius: 'var(--radius-lg)',
        }}>
          <span style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.82rem', color: 'var(--accent)' }}>
            {selectedCount.toLocaleString()} selected
          </span>
          {!selectAllMatching && contacts.every((c) => selectedIds.has(c.id)) && total > selectedCount && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setSelectAllMatching(true); setSelectedIds(new Set()) }}>
              Select all {total.toLocaleString()} matching
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn btn-secondary btn-sm" disabled={bulkBusy} onClick={() => sendConsent(false)}>Request consent</button>
          <button className="btn btn-secondary btn-sm" disabled={bulkBusy} onClick={onAddTag}>Add tag</button>
          <button className="btn btn-secondary btn-sm" disabled={bulkBusy} onClick={onRemoveTag}>Remove tag</button>
          <button className="btn btn-secondary btn-sm" disabled={bulkBusy} onClick={onSetField}>Set field…</button>
          <button className="btn btn-secondary btn-sm" disabled={bulkBusy} onClick={onMarkConsented}>Mark consented</button>
          <button className="btn btn-secondary btn-sm" disabled={bulkBusy} onClick={onMarkRevoked}>Mark revoked</button>
          <button className="btn btn-ghost btn-sm" disabled={bulkBusy} onClick={onBulkDelete} style={{ color: 'var(--red)' }}>Delete</button>
          <button className="btn btn-ghost btn-sm" onClick={clearSelection}>Clear</button>
        </div>
      )}

      {/* Two-panel layout */}
      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 300px' : '1fr', gap: '1rem' }}>
        {/* Table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label="Select page"
                      checked={contacts.length > 0 && (selectAllMatching || contacts.every((c) => selectedIds.has(c.id)))}
                      ref={(el) => {
                        if (el) {
                          const some = contacts.some((c) => selectedIds.has(c.id))
                          const all  = contacts.length > 0 && contacts.every((c) => selectedIds.has(c.id))
                          el.indeterminate = !selectAllMatching && some && !all
                        }
                      }}
                      onChange={togglePage}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Consent</th>
                  <th>Tags</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j}><div className="skeleton" style={{ height: '12px', width: `${60 + Math.random() * 30}%` }} /></td>
                      ))}
                    </tr>
                  ))
                ) : contacts.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-state-icon">◈</div>
                        <div className="empty-state-title">No contacts found</div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  contacts.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelected(selected?.id === c.id ? null : c)}
                      style={{
                        cursor: 'pointer',
                        background: selected?.id === c.id ? 'var(--bg-active)' : undefined,
                      }}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.name}`}
                          checked={selectAllMatching || selectedIds.has(c.id)}
                          onChange={() => toggleRow(c.id)}
                        />
                      </td>
                      <td className="td-name">{c.name}</td>
                      <td className="td-mono">{c.email ?? '—'}</td>
                      <td className="td-mono">{c.phone ?? '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          {c.consent_email && <span className="badge badge-green" style={{ fontSize: '0.6rem' }}>E</span>}
                          {c.consent_whatsapp && <span className="badge badge-green" style={{ fontSize: '0.6rem' }}>W</span>}
                          {c.consent_voice && <span className="badge badge-green" style={{ fontSize: '0.6rem' }}>V</span>}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                          {c.tags.slice(0, 3).map((t) => <span key={t} className="badge badge-gray" style={{ fontSize: '0.6rem' }}>{t}</span>)}
                          {c.tags.length > 3 && <span className="text-xs text-muted">+{c.tags.length - 3}</span>}
                        </div>
                      </td>
                      <td className="td-mono text-xs">{formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border-subtle)' }}>
            <div className="pagination">
              <span>{total} total</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{page} / {Math.max(1, totalPages)}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next →</button>
            </div>
          </div>
        </div>

        {/* Detail panel */}
        {selected && (
          <ContactDetail
            contact={selected}
            onEdit={() => { setEditContact(selected); setShowForm(true) }}
            onDelete={() => { setSelected(null); loadContacts() }}
          />
        )}
      </div>

      {/* Modals */}
      {showForm && (
        <ContactForm
          contact={editContact}
          onClose={() => { setShowForm(false); setEditContact(undefined) }}
          onSaved={loadContacts}
        />
      )}
      {showUpload && (
        <BulkUploadModal
          onClose={() => setShowUpload(false)}
          onDone={() => { setShowUpload(false); loadContacts() }}
        />
      )}

      {bulkPrompt && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setBulkPrompt(null)}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {bulkPrompt === 'add_tag' ? 'Add tag to selected' :
                 bulkPrompt === 'remove_tag' ? 'Remove tag from selected' :
                 'Set field on selected'}
              </h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setBulkPrompt(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="text-xs text-muted">
                Will affect {selectedCount.toLocaleString()} contact{selectedCount === 1 ? '' : 's'}.
              </div>
              {bulkPrompt === 'set_field' && (
                <div>
                  <div className="section-label">Field</div>
                  <select className="form-control" value={promptField} onChange={(e) => setPromptField(e.target.value as typeof promptField)}>
                    <option value="country_code">country_code (e.g. SA, AE)</option>
                    <option value="country_name_ar">country_name_ar</option>
                    <option value="industry">industry (e.g. construction, oil_gas)</option>
                    <option value="industry_ar">industry_ar</option>
                    <option value="region_tier">region_tier (e.g. tier1, tier2)</option>
                  </select>
                </div>
              )}
              <div>
                <div className="section-label">{bulkPrompt === 'set_field' ? 'Value (empty = clear)' : 'Tag'}</div>
                <input className="form-control" autoFocus value={promptValue}
                       onChange={(e) => setPromptValue(e.target.value)}
                       onKeyDown={(e) => e.key === 'Enter' && submitPrompt()} />
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button className="btn btn-ghost" onClick={() => setBulkPrompt(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={bulkBusy} onClick={submitPrompt}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
