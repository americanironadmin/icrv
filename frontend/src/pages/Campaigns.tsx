// src/pages/Campaigns.tsx
// Campaigns module: list, create, launch, pause, view tracking

import React, { useState, useEffect, useCallback } from 'react'
import { campaignsApi, type Campaign, type CampaignCreatePayload, type Template, type CampaignChannel } from '@/api/campaigns'
import { adminApi, type IntegrationsState } from '@/api/admin'
import { useApp } from '@/context/AppContext'
import { formatDistanceToNow, format } from 'date-fns'

// Maps the campaign channel to the integration that supplies its dispatch credential.
// Email steps store oauth_tokens.id; WhatsApp/voice steps store api_credentials.id.
function credentialForChannel(
  ch: CampaignChannel,
  integ: IntegrationsState | null,
): { id: string | null; label: string | null; settingsHint: string } {
  if (!integ) return { id: null, label: null, settingsHint: 'Loading…' }
  if (ch === 'email') {
    return {
      id: integ.gmail.oauth_token_id,
      label: integ.gmail.email,
      settingsHint: 'Connect Gmail in Settings',
    }
  }
  if (ch === 'whatsapp') {
    return {
      id: integ.whatsapp.credential_id,
      label: integ.whatsapp.label,
      settingsHint: 'Connect WhatsApp in Settings',
    }
  }
  // voice — RingCentral is the per-step credential; ElevenLabs is resolved server-side.
  return {
    id: integ.ringcentral.credential_id,
    label: integ.ringcentral.label,
    settingsHint: 'Connect RingCentral in Settings',
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: Campaign['status']) {
  const map: Record<Campaign['status'], string> = {
    draft:     'badge-gray',
    active:    'badge-green',
    paused:    'badge-yellow',
    completed: 'badge-blue',
    cancelled: 'badge-red',
  }
  return <span className={`badge ${map[status]}`}>{status}</span>
}

function channelBadge(channel: CampaignChannel) {
  const map: Record<CampaignChannel, string> = { email: 'badge-blue', whatsapp: 'badge-green', voice: 'badge-accent' }
  return <span className={`badge ${map[channel]}`}>{channel}</span>
}

// ── Campaign Form Modal ───────────────────────────────────────────────────────

function CampaignForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { showToast } = useApp()
  const [step, setStep] = useState(0)
  const [templates, setTemplates] = useState<Template[]>([])
  const [integrations, setIntegrations] = useState<IntegrationsState | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<CampaignCreatePayload>({
    name: '',
    description: '',
    channel: 'email',
    steps: [],
  })
  const [stepForm, setStepForm] = useState({
    template_id: '',
    credential_id: '',
    delay_hours: 24,
  })
  const [inlineTemplate, setInlineTemplate] = useState({
    subject: '',
    body_html: '',
  })

  useEffect(() => {
    const load = async () => {
      try {
        const [tplRes, integRes] = await Promise.all([
          campaignsApi.listTemplates(form.channel),
          adminApi.getIntegrations(),
        ])
        setTemplates(tplRes.templates)
        setIntegrations(integRes)
      } catch {
        // non-fatal
      }
    }
    load()
  }, [form.channel])

  // When channel changes (or integrations finish loading), auto-bind the matching
  // connected credential to the in-flight step form so users don't need to know UUIDs.
  useEffect(() => {
    const cred = credentialForChannel(form.channel, integrations)
    setStepForm((p) => ({ ...p, credential_id: cred.id ?? '' }))
  }, [form.channel, integrations])

  const setF = (k: keyof CampaignCreatePayload, v: unknown) =>
    setForm((p) => ({ ...p, [k]: v }))

  const addStep = () => {
    if (!stepForm.template_id) {
      showToast({ type: 'warning', title: 'Select a template' })
      return
    }
    if (!stepForm.credential_id) {
      const cred = credentialForChannel(form.channel, integrations)
      showToast({ type: 'warning', title: 'No credential connected', message: cred.settingsHint })
      return
    }
    setF('steps', [...form.steps, {
      step_index: form.steps.length,
      channel: form.channel,
      template_id: stepForm.template_id,
      credential_id: stepForm.credential_id,
      delay_hours: stepForm.delay_hours,
    }])
    setStepForm({ template_id: '', credential_id: '', delay_hours: 24 })
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) { showToast({ type: 'warning', title: 'Campaign name required' }); return }

    // Inline-template shortcut: if the user filled the Step 0 inline template
    // and didn't add manual steps, save the template and auto-add a single
    // step that uses it. This makes the Steps tab optional for the common
    // "one email, send now" case.
    let payload: CampaignCreatePayload = form
    if (
      form.steps.length === 0 &&
      form.channel === 'email' &&
      inlineTemplate.subject.trim() &&
      inlineTemplate.body_html.trim()
    ) {
      const cred = credentialForChannel('email', integrations)
      if (!cred.id) {
        showToast({ type: 'warning', title: 'No Gmail account connected', message: cred.settingsHint })
        return
      }
      try {
        const tpl = await campaignsApi.createTemplate({
          name: form.name || 'Inline template',
          channel: 'email',
          subject: inlineTemplate.subject,
          body_html: inlineTemplate.body_html,
        })
        payload = {
          ...form,
          steps: [{
            step_index: 0,
            channel: 'email',
            template_id: tpl.id,
            credential_id: cred.id,
            delay_hours: 0,
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Template create failed'
        showToast({ type: 'error', title: 'Inline template failed', message: msg })
        return
      }
    }

    if (payload.steps.length === 0) {
      showToast({ type: 'warning', title: 'Add at least one step', message: 'Or fill in the inline template on the Details tab.' })
      return
    }

    setSaving(true)
    try {
      await campaignsApi.create(payload)
      showToast({ type: 'success', title: 'Campaign created', message: payload.name })
      onSaved()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Create failed'
      showToast({ type: 'error', title: 'Error', message: msg })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: '700px' }}>
        <div className="modal-header">
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            New Campaign
          </h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>

        {/* Step tabs */}
        <div style={{ padding: '0 1.5rem' }}>
          <div className="tabs">
            {['Details', 'Steps', 'Review'].map((t, i) => (
              <button key={t} className={`tab-btn ${step === i ? 'active' : ''}`} onClick={() => setStep(i)}>{t}</button>
            ))}
          </div>
        </div>

        <div className="modal-body">
          {/* Step 0: Details */}
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Campaign Name *</label>
                <input className="form-control" value={form.name} onChange={(e) => setF('name', e.target.value)} placeholder="Q4 Outreach" />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-control" value={form.description} onChange={(e) => setF('description', e.target.value)} placeholder="Campaign objective..." style={{ minHeight: '80px' }} />
              </div>
              <div className="form-group">
                <label className="form-label">Channel</label>
                <select className="form-control" value={form.channel} onChange={(e) => setF('channel', e.target.value as CampaignChannel)}>
                  <option value="email">Email</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="voice">Voice</option>
                </select>
              </div>
              {form.channel === 'email' && (
                <>
                  <div className="section-label" style={{ marginBottom: 0 }}>Inline Email Template (optional)</div>
                  <div className="form-group">
                    <label className="form-label">Subject</label>
                    <input className="form-control" value={inlineTemplate.subject} onChange={(e) => setInlineTemplate(p => ({ ...p, subject: e.target.value }))} placeholder="Subject line…" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Body HTML</label>
                    <textarea className="form-control form-control-mono" value={inlineTemplate.body_html} onChange={(e) => setInlineTemplate(p => ({ ...p, body_html: e.target.value }))} placeholder="<p>Hello {{name}},…" style={{ minHeight: '160px' }} />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 1: Steps */}
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {form.steps.length > 0 && (
                <div>
                  {form.steps.map((s, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      padding: '0.65rem', background: 'var(--bg-base)',
                      borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)',
                      marginBottom: '0.5rem',
                    }}>
                      <span className="badge badge-gray">Step {i + 1}</span>
                      <span className="text-sm">{s.template_id}</span>
                      <span className="text-xs text-muted font-mono">after {s.delay_hours}h</span>
                      <button className="btn btn-ghost btn-icon" style={{ marginLeft: 'auto' }} onClick={() => setF('steps', form.steps.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ padding: '1rem', background: 'var(--bg-base)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)' }}>
                <div className="section-label">Add Step</div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Template</label>
                    <select className="form-control" value={stepForm.template_id} onChange={(e) => setStepForm(p => ({ ...p, template_id: e.target.value }))}>
                      <option value="">Select template…</option>
                      {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Sending from</label>
                    {(() => {
                      const cred = credentialForChannel(form.channel, integrations)
                      if (!cred.id) {
                        return (
                          <div className="form-control" style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            {cred.settingsHint}
                          </div>
                        )
                      }
                      return (
                        <div className="form-control" style={{ display: 'flex', alignItems: 'center' }}>
                          <span className="badge badge-green" style={{ marginRight: '0.5rem' }}>connected</span>
                          <span className="text-sm">{cred.label ?? cred.id}</span>
                        </div>
                      )
                    })()}
                  </div>
                  <div className="form-group">
                    <label className="form-label">Delay (hours)</label>
                    <input className="form-control" type="number" min={0} value={stepForm.delay_hours} onChange={(e) => setStepForm(p => ({ ...p, delay_hours: parseInt(e.target.value) || 0 }))} />
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={addStep} style={{ marginTop: '0.5rem' }}>+ Add Step</button>
              </div>
            </div>
          )}

          {/* Step 2: Review */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="text-xs font-display text-muted">Name</span>
                <span className="text-sm">{form.name}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="text-xs font-display text-muted">Channel</span>
                {channelBadge(form.channel)}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="text-xs font-display text-muted">Steps</span>
                <span className="text-sm">{form.steps.length}</span>
              </div>
              {form.description && (
                <div>
                  <div className="text-xs font-display text-muted" style={{ marginBottom: '0.25rem' }}>Description</div>
                  <div className="text-sm">{form.description}</div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          {step < 2 && <button className="btn btn-secondary" onClick={() => setStep(s => s + 1)}>Next →</button>}
          {step === 2 && (
            <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Creating…' : 'Create Campaign'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Campaign Detail ───────────────────────────────────────────────────────────

function CampaignDetail({ campaign, onRefresh }: { campaign: Campaign; onRefresh: () => void }) {
  const { showToast } = useApp()
  const [actionLoading, setActionLoading] = useState(false)

  const doAction = async (action: 'launch' | 'pause' | 'resume' | 'cancel') => {
    setActionLoading(true)
    try {
      if (action === 'launch') {
        const res = await campaignsApi.launch(campaign.id)
        // The campaign tick runs once per minute; first dispatch happens within ~60s of launch.
        // Surface this so operators don't cancel mid-race and assume nothing is happening.
        showToast({
          type: 'success',
          title: 'Campaign launched',
          message: `${res.enrolled} contact${res.enrolled === 1 ? '' : 's'} enrolled. First message dispatches within 60 seconds — give it a minute before pausing or cancelling.`,
        })
      } else if (action === 'pause') {
        await campaignsApi.pause(campaign.id)
        showToast({ type: 'info', title: 'Campaign paused' })
      } else if (action === 'resume') {
        await campaignsApi.resume(campaign.id)
        showToast({ type: 'success', title: 'Campaign resumed' })
      } else {
        await campaignsApi.cancel(campaign.id)
        showToast({ type: 'warning', title: 'Campaign cancelled' })
      }
      onRefresh()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Action failed'
      showToast({ type: 'error', title: 'Error', message: msg })
    } finally {
      setActionLoading(false)
    }
  }

  const rate = campaign.sent_count > 0 ? Math.round((campaign.opened_count / campaign.sent_count) * 100) : 0

  return (
    <div className="card" style={{ height: '100%' }}>
      <div className="card-header">
        <span className="card-title">Campaign Detail</span>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {campaign.status === 'draft'  && <button className="btn btn-primary btn-sm" onClick={() => doAction('launch')} disabled={actionLoading}>▶ Launch</button>}
          {campaign.status === 'active' && <button className="btn btn-secondary btn-sm" onClick={() => doAction('pause')} disabled={actionLoading}>⏸ Pause</button>}
          {campaign.status === 'paused' && <button className="btn btn-primary btn-sm" onClick={() => doAction('resume')} disabled={actionLoading}>▶ Resume</button>}
          {['draft','active','paused'].includes(campaign.status) && <button className="btn btn-danger btn-sm" onClick={() => doAction('cancel')} disabled={actionLoading}>✕</button>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>{campaign.name}</div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {statusBadge(campaign.status)}
          {channelBadge(campaign.channel)}
        </div>
        {campaign.description && <p className="text-sm">{campaign.description}</p>}

        <div className="divider" />

        {/* Tracking stats */}
        <div className="section-label">Tracking</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          {[
            { label: 'Enrolled', value: campaign.enrolled_count },
            { label: 'Sent', value: campaign.sent_count },
            { label: 'Opened', value: campaign.opened_count },
            { label: 'Clicked', value: campaign.clicked_count },
            { label: 'Replied', value: campaign.replied_count },
            { label: 'Failed', value: campaign.failed_count },
          ].map(({ label, value }) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0.6rem', background: 'var(--bg-base)', borderRadius: 'var(--radius-sm)' }}>
              <span className="text-xs font-display text-muted">{label}</span>
              <span className="text-sm font-mono">{value.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div className="text-xs text-muted font-mono" style={{ marginTop: '0.25rem' }}>
          Open rate: {rate}%
        </div>

        <div className="divider" />
        {campaign.launched_at && (
          <div className="text-xs text-muted font-mono">
            Launched {format(new Date(campaign.launched_at), 'MMM d, yyyy HH:mm')}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Campaigns Page ───────────────────────────────────────────────────────

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Campaign | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await campaignsApi.list({
        per_page: 50,
        status: statusFilter as Campaign['status'] || undefined,
      })
      setCampaigns(res.campaigns)
      setTotal(res.total)
    } catch {
      // interceptor handles
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Campaigns</h1>
          <p className="page-subtitle">{total} campaigns</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>+ New Campaign</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {['', 'draft', 'active', 'paused', 'completed', 'cancelled'].map((s) => (
          <button
            key={s || 'all'}
            className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter(s)}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 340px' : '1fr', gap: '1rem' }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Sent</th>
                  <th>Opens</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j}><div className="skeleton" style={{ height: '12px' }} /></td>
                      ))}
                    </tr>
                  ))
                ) : campaigns.length === 0 ? (
                  <tr><td colSpan={6}><div className="empty-state"><div className="empty-state-icon">▶</div><div className="empty-state-title">No campaigns</div></div></td></tr>
                ) : (
                  campaigns.map((c) => (
                    <tr
                      key={c.id}
                      style={{ cursor: 'pointer', background: selected?.id === c.id ? 'var(--bg-active)' : undefined }}
                      onClick={() => setSelected(selected?.id === c.id ? null : c)}
                    >
                      <td className="td-name">
                        <div>{c.name}</div>
                        {c.description && <div className="text-xs text-muted" style={{ marginTop: '0.1rem' }}>{c.description.substring(0, 40)}</div>}
                      </td>
                      <td>{channelBadge(c.channel)}</td>
                      <td>{statusBadge(c.status)}</td>
                      <td className="td-mono">{c.sent_count.toLocaleString()}</td>
                      <td className="td-mono">{c.opened_count.toLocaleString()}</td>
                      <td className="td-mono text-xs">{formatDistanceToNow(new Date(c.updated_at), { addSuffix: true })}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {selected && (
          <CampaignDetail
            campaign={selected}
            onRefresh={() => { load(); setSelected(null) }}
          />
        )}
      </div>

      {showForm && (
        <CampaignForm
          onClose={() => setShowForm(false)}
          onSaved={() => { load(); setShowForm(false) }}
        />
      )}
    </div>
  )
}
