// src/pages/Settings.tsx
// Settings shell with sub-routes:
//   /settings              → Integrations (default)
//   /settings/integrations → WhatsApp + ElevenLabs (existing)
//   /settings/general      → Workspace (Phase 2)
//   /settings/compliance   → CAN-SPAM physical address + unsubscribe text (Phase 2)
//   /settings/sending      → Daily limit + throttle + warmup (Phase 2)
//   /settings/tracking     → Open/click tracking + UTM (Phase 3)
//   /settings/authentication → DKIM/SPF/DMARC (Phase 3)
//   /settings/personalization → custom variables (Phase 5)
//   /settings/bounces      → bounce thresholds (Phase 5)
//   /settings/api-webhooks → API key + webhooks (Phase 5)

import React, { useEffect, useState, useCallback } from 'react'
import { Routes, Route, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { adminApi, type IntegrationsState } from '@/api/admin'
import {
  settingsApi,
  type WorkspaceSettings,
  type ComplianceSettings,
  type SendingSettings,
  type TrackingSettings,
  type AuthenticationSettings,
  type BounceSettings,
} from '@/api/settings'
import { useApp } from '@/context/AppContext'

// ── Layout shell ──────────────────────────────────────────────────────────

const TABS: { path: string; label: string }[] = [
  { path: 'integrations',    label: 'Integrations' },
  { path: 'general',         label: 'General' },
  { path: 'compliance',      label: 'Compliance' },
  { path: 'sending',         label: 'Sending' },
  { path: 'tracking',        label: 'Tracking & Analytics' },
  { path: 'authentication',  label: 'Email Auth' },
  { path: 'personalization', label: 'Personalization' },
  { path: 'bounces',         label: 'Bounce Handling' },
  { path: 'api-webhooks',    label: 'API & Webhooks' },
]

export default function Settings() {
  const navigate = useNavigate()
  const location = useLocation()

  // Default landing → integrations.
  useEffect(() => {
    if (location.pathname === '/settings' || location.pathname === '/settings/') {
      navigate('integrations', { replace: true })
    }
  }, [location.pathname, navigate])

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1080 }}>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
        Settings
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
        Configure how ICRV reaches your customers. Changes persist immediately.
      </p>

      <nav style={{
        display: 'flex',
        gap: '0.25rem',
        flexWrap: 'wrap',
        borderBottom: '1px solid var(--border-default)',
        marginBottom: '1.5rem',
      }}>
        {TABS.map((t) => (
          <NavLink
            key={t.path}
            to={t.path}
            className={({ isActive }) => `settings-tab${isActive ? ' is-active' : ''}`}
            style={({ isActive }) => ({
              padding: '0.6rem 0.85rem',
              fontFamily: 'var(--font-display)',
              fontSize: '0.78rem',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              textDecoration: 'none',
              color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
              marginBottom: '-1px',
            })}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route path="integrations"    element={<IntegrationsPanel />} />
        <Route path="general"         element={<GeneralPanel />} />
        <Route path="compliance"      element={<CompliancePanel />} />
        <Route path="sending"         element={<SendingPanel />} />
        <Route path="tracking"        element={<TrackingPanel />} />
        <Route path="authentication"  element={<AuthenticationPanel />} />
        <Route path="personalization" element={<ComingSoon name="Personalization" />} />
        <Route path="bounces"         element={<BouncesPanel />} />
        <Route path="api-webhooks"    element={<ApiWebhooksPanel />} />
      </Routes>
    </div>
  )
}

// ── Card primitive ────────────────────────────────────────────────────────

function Card({ title, subtitle, children, footer }: {
  title: string
  subtitle?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <section style={{
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-lg)',
      padding: '1.25rem 1.5rem',
      background: 'var(--bg-surface)',
      marginBottom: '1rem',
    }}>
      <h2 style={{
        fontFamily: 'var(--font-display)',
        fontSize: '0.95rem',
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: 'var(--accent)',
        marginBottom: subtitle ? '0.25rem' : '0.85rem',
      }}>{title}</h2>
      {subtitle && <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '0.85rem' }}>{subtitle}</p>}
      {children}
      {footer && <div style={{ marginTop: '1rem' }}>{footer}</div>}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '0.85rem' }}>
      <label style={{
        display: 'block',
        fontSize: '0.7rem',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--text-secondary)',
        marginBottom: '0.3rem',
      }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{hint}</div>}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.6rem',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.82rem',
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
}

// ── Integrations (existing UI, rebadged) ──────────────────────────────────

function IntegrationsPanel() {
  const { showToast } = useApp()
  const [state, setState] = useState<IntegrationsState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [waPhoneNumberId, setWaPhoneNumberId] = useState('')
  const [waBusinessId,    setWaBusinessId]    = useState('')
  const [waAccessToken,   setWaAccessToken]   = useState('')
  const [waBusy,          setWaBusy]          = useState(false)

  const [elAgentId,       setElAgentId]       = useState('')
  const [elPhoneNumberId, setElPhoneNumberId] = useState('')
  const [elBusy,          setElBusy]          = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await adminApi.getIntegrations()
      setState(data)
      setWaPhoneNumberId(data.whatsapp.metadata.phone_number_id ?? '')
      setWaBusinessId(data.whatsapp.metadata.business_id ?? '')
      setElAgentId(data.elevenlabs.agent_id ?? '')
      setElPhoneNumberId(data.elevenlabs.metadata.phone_number_id ?? '')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load integrations'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  if (loading && !state) return <div style={{ padding: '1.5rem', color: 'var(--text-muted)' }}>Loading integrations…</div>
  if (error) return <div style={{ padding: '1.5rem', color: 'var(--red)' }}>Error: {error}</div>
  if (!state) return null

  const submitWhatsApp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!waPhoneNumberId.trim() || !waAccessToken.trim()) {
      showToast({ type: 'error', title: 'WhatsApp', message: 'phone_number_id and access_token required' })
      return
    }
    setWaBusy(true)
    try {
      await adminApi.saveWhatsApp({
        phone_number_id: waPhoneNumberId.trim(),
        business_id:     waBusinessId.trim(),
        access_token:    waAccessToken.trim(),
      })
      showToast({ type: 'success', title: 'WhatsApp saved' })
      setWaAccessToken('')
      await refresh()
    } catch (e: unknown) {
      showToast({ type: 'error', title: 'WhatsApp save failed', message: (e as Error)?.message ?? 'Unknown error' })
    } finally {
      setWaBusy(false)
    }
  }

  const submitElevenLabs = async (e: React.FormEvent) => {
    e.preventDefault()
    setElBusy(true)
    try {
      await adminApi.saveElevenLabs({
        agent_id: elAgentId.trim() || undefined,
        phone_number_id: elPhoneNumberId.trim() || undefined,
      })
      showToast({ type: 'success', title: 'ElevenLabs saved' })
      await refresh()
    } catch (e: unknown) {
      showToast({ type: 'error', title: 'ElevenLabs save failed', message: (e as Error)?.message ?? 'Unknown error' })
    } finally {
      setElBusy(false)
    }
  }

  return (
    <div>
      <Card title="Current Status">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '0.85rem' }}>
          {[
            { label: 'Gmail',       ok: state.gmail.connected,       extra: state.gmail.email },
            { label: 'WhatsApp',    ok: state.whatsapp.connected,    extra: state.whatsapp.metadata.phone_number_id },
            { label: 'RingCentral', ok: state.ringcentral.connected, extra: state.ringcentral.label },
            { label: 'ElevenLabs',  ok: state.elevenlabs.connected,  extra: state.elevenlabs.agent_id },
          ].map((s) => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: s.ok ? 'var(--green)' : 'var(--red)' }} />
              <span style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.78rem' }}>
                {s.label}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                {s.extra ? `— ${s.extra}` : '(not connected)'}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="WhatsApp Business (Meta)" subtitle="Get these from Meta App Dashboard → WhatsApp → API Setup. The token is encrypted at rest.">
        <form onSubmit={submitWhatsApp}>
          <Field label="Phone Number ID *">
            <input style={inputStyle} value={waPhoneNumberId} onChange={(e) => setWaPhoneNumberId(e.target.value)} placeholder="e.g. 123456789012345" />
          </Field>
          <Field label="Business Account ID">
            <input style={inputStyle} value={waBusinessId} onChange={(e) => setWaBusinessId(e.target.value)} placeholder="optional" />
          </Field>
          <Field label="Permanent Access Token *">
            <input type="password" style={inputStyle} value={waAccessToken} onChange={(e) => setWaAccessToken(e.target.value)} placeholder="EAA…" />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={waBusy}>{waBusy ? 'Saving…' : 'Save WhatsApp'}</button>
        </form>
      </Card>

      <Card title="ElevenLabs Voice Agent" subtitle="Tell the system which agent to use and which phone number is attached to it.">
        <form onSubmit={submitElevenLabs}>
          <Field label="Agent ID">
            <input style={inputStyle} value={elAgentId} onChange={(e) => setElAgentId(e.target.value)} placeholder="agent_…" />
          </Field>
          <Field label="Agent Phone Number ID">
            <input style={inputStyle} value={elPhoneNumberId} onChange={(e) => setElPhoneNumberId(e.target.value)} placeholder="phnum_…" />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={elBusy}>{elBusy ? 'Saving…' : 'Save ElevenLabs'}</button>
        </form>
      </Card>
    </div>
  )
}

// ── Sectioned form helper ─────────────────────────────────────────────────

function useSection<T>(section: 'workspace'|'compliance'|'sending'|'tracking'|'authentication'|'bounce', initial: T) {
  const [data, setData] = useState<T>(initial)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const { showToast } = useApp()

  useEffect(() => {
    settingsApi.getSection<T>(section)
      .then((d) => { setData({ ...initial, ...d }); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [section]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true)
    try {
      const next = await settingsApi.saveSection<T>(section, data as never)
      setData(next)
      showToast({ type: 'success', title: 'Saved' })
    } catch (e: unknown) {
      showToast({ type: 'error', title: 'Save failed', message: (e as Error)?.message ?? 'Unknown error' })
    } finally {
      setBusy(false)
    }
  }

  return { data, setData, loaded, busy, save }
}

// ── General (workspace) ───────────────────────────────────────────────────

function GeneralPanel() {
  const { data, setData, loaded, busy, save } = useSection<WorkspaceSettings>('workspace', {
    company_name: 'American Iron LLC',
    website: 'https://americaniron1.com',
    timezone: 'America/New_York',
  })
  if (!loaded) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  return (
    <Card title="Workspace" subtitle="Identity used across the dashboard, email footers, and exported reports."
          footer={<button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Workspace'}</button>}>
      <Field label="Company Name">
        <input style={inputStyle} value={data.company_name} onChange={(e) => setData({ ...data, company_name: e.target.value })} />
      </Field>
      <Field label="Website">
        <input style={inputStyle} value={data.website} onChange={(e) => setData({ ...data, website: e.target.value })} placeholder="https://example.com" />
      </Field>
      <Field label="Timezone" hint="IANA timezone, e.g. America/New_York or Asia/Riyadh">
        <input style={inputStyle} value={data.timezone} onChange={(e) => setData({ ...data, timezone: e.target.value })} />
      </Field>
    </Card>
  )
}

// ── Compliance ─────────────────────────────────────────────────────────────

function CompliancePanel() {
  const { data, setData, loaded, busy, save } = useSection<ComplianceSettings>('compliance', {
    physical_address: { street: '__PLACEHOLDER__', city: '', state: '', zip: '', country: 'US' },
    unsubscribe_text: 'To stop receiving these emails, unsubscribe here: {{unsubscribe_url}}',
  })
  if (!loaded) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>

  const isPlaceholder = data.physical_address.street === '__PLACEHOLDER__' || !data.physical_address.street.trim()

  return (
    <>
      {isPlaceholder && (
        <div style={{
          padding: '0.85rem 1rem',
          marginBottom: '1rem',
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid var(--red)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--red)',
          fontSize: '0.85rem',
        }}>
          ⚠ Add your physical address before sending real campaigns — required by CAN-SPAM (US) and similar laws elsewhere. Sends will be blocked (HTTP 422) until you do.
        </div>
      )}
      <Card title="CAN-SPAM Physical Address" subtitle="Included automatically in every email footer. Required by US law for marketing email."
            footer={<button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Compliance'}</button>}>
        <Field label="Street">
          <input style={inputStyle} value={data.physical_address.street}
                 onChange={(e) => setData({ ...data, physical_address: { ...data.physical_address, street: e.target.value } })} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem' }}>
          <Field label="City">
            <input style={inputStyle} value={data.physical_address.city}
                   onChange={(e) => setData({ ...data, physical_address: { ...data.physical_address, city: e.target.value } })} />
          </Field>
          <Field label="State">
            <input style={inputStyle} value={data.physical_address.state}
                   onChange={(e) => setData({ ...data, physical_address: { ...data.physical_address, state: e.target.value } })} />
          </Field>
          <Field label="ZIP">
            <input style={inputStyle} value={data.physical_address.zip}
                   onChange={(e) => setData({ ...data, physical_address: { ...data.physical_address, zip: e.target.value } })} />
          </Field>
        </div>
        <Field label="Country" hint="ISO 3166-1 alpha-2 code (US, AE, SA …)">
          <input style={inputStyle} value={data.physical_address.country}
                 onChange={(e) => setData({ ...data, physical_address: { ...data.physical_address, country: e.target.value } })} />
        </Field>
        <Field label="Unsubscribe Footer Text" hint="Use {{unsubscribe_url}} placeholder; the worker substitutes a tokenized link.">
          <textarea style={{ ...inputStyle, minHeight: 70, fontFamily: 'var(--font-mono)' }}
                    value={data.unsubscribe_text}
                    onChange={(e) => setData({ ...data, unsubscribe_text: e.target.value })} />
        </Field>
      </Card>
    </>
  )
}

// ── Sending ────────────────────────────────────────────────────────────────

function SendingPanel() {
  const { data, setData, loaded, busy, save } = useSection<SendingSettings>('sending', {
    daily_limit: 500, throttle_per_sec: 5, warmup_enabled: false, custom_from_domain: '',
  })
  if (!loaded) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  return (
    <Card title="Sending Limits & Throttling" subtitle="Caps protect your sender reputation and prevent runaway costs."
          footer={<button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Sending'}</button>}>
      <Field label="Daily Send Limit (emails / day)" hint="Hard cap. Excess sends are queued for the next day.">
        <input type="number" min={1} max={100000} style={inputStyle}
               value={data.daily_limit}
               onChange={(e) => setData({ ...data, daily_limit: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
      </Field>
      <Field label="Throttle (emails / second)" hint="Token-bucket rate limit at the email worker.">
        <input type="number" min={1} max={50} style={inputStyle}
               value={data.throttle_per_sec}
               onChange={(e) => setData({ ...data, throttle_per_sec: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
      </Field>
      <Field label="Warmup Enabled" hint="Gradually increase volume over the first 14 days for new sending domains.">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={data.warmup_enabled}
                 onChange={(e) => setData({ ...data, warmup_enabled: e.target.checked })} />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{data.warmup_enabled ? 'On' : 'Off'}</span>
        </label>
      </Field>
      <Field label="Custom From Domain (optional)" hint="If set, From: addresses use this domain instead of the connected Gmail.">
        <input style={inputStyle} value={data.custom_from_domain}
               onChange={(e) => setData({ ...data, custom_from_domain: e.target.value })}
               placeholder="e.g. mail.americanironus.com" />
      </Field>
    </Card>
  )
}

// ── Tracking & Analytics (Phase 3) ────────────────────────────────────────

function TrackingPanel() {
  const { data, setData, loaded, busy, save } = useSection<TrackingSettings>('tracking', {
    open_tracking: true, click_tracking: true, custom_domain: '',
    utm_prefix: 'icrv', utm_medium: 'email', utm_campaign_prefix: '', google_analytics: false,
  })
  if (!loaded) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  return (
    <Card title="Tracking & Analytics" subtitle="What gets measured and how URLs are rewritten."
          footer={<button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Tracking'}</button>}>
      <Field label="Open Tracking">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={data.open_tracking} onChange={(e) => setData({ ...data, open_tracking: e.target.checked })} />
          <span style={{ fontSize: '0.85rem' }}>Inject 1×1 tracking pixel into every email.</span>
        </label>
      </Field>
      <Field label="Click Tracking">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={data.click_tracking} onChange={(e) => setData({ ...data, click_tracking: e.target.checked })} />
          <span style={{ fontSize: '0.85rem' }}>Rewrite outbound links to log clicks before redirecting.</span>
        </label>
      </Field>
      <Field label="Custom Tracking Domain (optional)" hint="CNAME to api.icrv.americanironus.com. Improves deliverability + visual continuity.">
        <input style={inputStyle} value={data.custom_domain}
               onChange={(e) => setData({ ...data, custom_domain: e.target.value })}
               placeholder="e.g. track.americanironus.com" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0.75rem' }}>
        <Field label="UTM Source Prefix">
          <input style={inputStyle} value={data.utm_prefix} onChange={(e) => setData({ ...data, utm_prefix: e.target.value })} />
        </Field>
        <Field label="UTM Medium">
          <input style={inputStyle} value={data.utm_medium} onChange={(e) => setData({ ...data, utm_medium: e.target.value })} />
        </Field>
        <Field label="UTM Campaign Prefix">
          <input style={inputStyle} value={data.utm_campaign_prefix} onChange={(e) => setData({ ...data, utm_campaign_prefix: e.target.value })} />
        </Field>
      </div>
      <Field label="Google Analytics integration">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={data.google_analytics} onChange={(e) => setData({ ...data, google_analytics: e.target.checked })} />
          <span style={{ fontSize: '0.85rem' }}>Forward UTM-tagged campaign clicks as GA events (requires GA4 property).</span>
        </label>
      </Field>
    </Card>
  )
}

// ── Email Authentication (Phase 3) ────────────────────────────────────────

function AuthenticationPanel() {
  const { showToast } = useApp()
  const { data, setData, loaded, busy, save } = useSection<AuthenticationSettings>('authentication', {
    domain: '', dkim_selector: 'icrv', dkim_public_key: '',
  })
  const [results, setResults] = useState<Record<string, { verified: boolean; found?: string; expected: string } | null>>({
    dkim: null, spf: null, dmarc: null,
  })
  const [checking, setChecking] = useState<string | null>(null)
  if (!loaded) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>

  const expectedDkim = data.dkim_public_key
    ? `${data.dkim_selector}._domainkey.${data.domain || 'YOUR_DOMAIN'} TXT "v=DKIM1; k=rsa; p=${data.dkim_public_key}"`
    : `${data.dkim_selector}._domainkey.${data.domain || 'YOUR_DOMAIN'} TXT "v=DKIM1; k=rsa; p=… (Save to generate)"`
  const expectedSpf = `v=spf1 include:_spf.google.com include:icrv-email.americanironadmin.workers.dev ~all`
  const expectedDmarc = `v=DMARC1; p=quarantine; rua=mailto:dmarc@${data.domain || 'YOUR_DOMAIN'}; ruf=mailto:dmarc@${data.domain || 'YOUR_DOMAIN'}; fo=1`

  const check = async (kind: 'dkim'|'spf'|'dmarc') => {
    if (!data.domain) { showToast({ type: 'error', title: 'Set a domain first' }); return }
    setChecking(kind)
    try {
      const url = `/v1/auth/check-${kind}?domain=${encodeURIComponent(data.domain)}&selector=${encodeURIComponent(data.dkim_selector)}`
      const res = await fetch((import.meta.env.VITE_API_BASE_URL || 'https://icrv-api.americanironus.com') + url, {
        credentials: 'include',
      })
      const json = await res.json() as { verified: boolean; found?: string; expected: string }
      setResults((r) => ({ ...r, [kind]: json }))
      showToast({
        type: json.verified ? 'success' : 'error',
        title: `${kind.toUpperCase()} ${json.verified ? 'verified' : 'not verified'}`,
      })
    } catch (e) {
      showToast({ type: 'error', title: `${kind.toUpperCase()} check failed`, message: (e as Error).message })
    } finally {
      setChecking(null)
    }
  }

  const copy = (s: string) => { navigator.clipboard?.writeText(s); showToast({ type: 'success', title: 'Copied' }) }

  return (
    <>
      <Card title="Sending Domain"
            footer={<button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Domain'}</button>}>
        <Field label="Domain" hint="The bare domain you send from (e.g. americaniron1.com)">
          <input style={inputStyle} value={data.domain} onChange={(e) => setData({ ...data, domain: e.target.value })} />
        </Field>
        <Field label="DKIM Selector">
          <input style={inputStyle} value={data.dkim_selector} onChange={(e) => setData({ ...data, dkim_selector: e.target.value })} />
        </Field>
      </Card>

      {(['dkim','spf','dmarc'] as const).map((kind) => {
        const expected = kind === 'dkim' ? expectedDkim : kind === 'spf' ? expectedSpf : expectedDmarc
        const r = results[kind]
        const status = r?.verified ? 'verified' : r ? 'not verified' : 'unchecked'
        const color = r?.verified ? 'var(--green)' : r ? 'var(--red)' : 'var(--text-muted)'
        return (
          <Card key={kind} title={kind.toUpperCase()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ color, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{status}</span>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => copy(expected)}>Copy</button>
                <button className="btn btn-secondary btn-sm" disabled={checking === kind} onClick={() => check(kind)}>
                  {checking === kind ? 'Checking…' : 'Check'}
                </button>
              </div>
            </div>
            <textarea readOnly value={expected} style={{ ...inputStyle, minHeight: 60, fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }} />
            {r?.found && <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>Found: <code>{r.found}</code></div>}
          </Card>
        )
      })}
    </>
  )
}

// ── Bounce Handling (Phase 5) ─────────────────────────────────────────────

function BouncesPanel() {
  const { data, setData, loaded, busy, save } = useSection<BounceSettings>('bounce', {
    hard_bounce_threshold: 3, soft_bounce_retries: 3, autounsub_on_complaint: true, bounce_notification_email: '',
  })
  if (!loaded) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  return (
    <Card title="Bounces & Complaints" subtitle="Protect your sender reputation by stopping sends to bad addresses."
          footer={<button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Bounce Settings'}</button>}>
      <Field label="Hard-bounce threshold" hint="Auto-suspend a contact after this many hard bounces.">
        <input type="number" min={1} max={20} style={inputStyle}
               value={data.hard_bounce_threshold}
               onChange={(e) => setData({ ...data, hard_bounce_threshold: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
      </Field>
      <Field label="Soft-bounce retries">
        <input type="number" min={0} max={10} style={inputStyle}
               value={data.soft_bounce_retries}
               onChange={(e) => setData({ ...data, soft_bounce_retries: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
      </Field>
      <Field label="Auto-unsubscribe on complaint">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={data.autounsub_on_complaint}
                 onChange={(e) => setData({ ...data, autounsub_on_complaint: e.target.checked })} />
          <span style={{ fontSize: '0.85rem' }}>Revoke email consent immediately when ISPs report a spam complaint.</span>
        </label>
      </Field>
      <Field label="Bounce notification email" hint="Where to send daily bounce summaries.">
        <input style={inputStyle} value={data.bounce_notification_email}
               onChange={(e) => setData({ ...data, bounce_notification_email: e.target.value })}
               placeholder="ops@example.com" />
      </Field>
    </Card>
  )
}

// ── API & Webhooks (Phase 5) ──────────────────────────────────────────────

interface ApiWebhooksData {
  api_key_last4: string | null
  api_key_created_at: string | null
  webhook_subscriptions: Array<{ id: string; event: string; url: string; secret_set: boolean }>
}

function ApiWebhooksPanel() {
  const { showToast } = useApp()
  const [data, setData] = useState<ApiWebhooksData>({ api_key_last4: null, api_key_created_at: null, webhook_subscriptions: [] })
  const [loaded, setLoaded] = useState(false)
  const [showSecret, setShowSecret] = useState<string | null>(null)
  const [newWebhook, setNewWebhook] = useState({ event: 'email_sent', url: '' })

  useEffect(() => {
    settingsApi.getSection<ApiWebhooksData>('api_webhooks')
      .then((d) => {
        setData({
          api_key_last4: d.api_key_last4 ?? null,
          api_key_created_at: d.api_key_created_at ?? null,
          webhook_subscriptions: d.webhook_subscriptions ?? [],
        })
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  const generate = async () => {
    try {
      const res = await fetch((import.meta.env.VITE_API_BASE_URL || 'https://icrv-api.americanironus.com') + '/v1/settings/api_webhooks/generate-key', {
        method: 'POST', credentials: 'include',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { api_key: string; last4: string }
      setShowSecret(json.api_key)
      setData({ ...data, api_key_last4: json.last4, api_key_created_at: new Date().toISOString() })
      showToast({ type: 'success', title: 'API key generated', message: 'Copy it now — we will not show it again.' })
    } catch (e) {
      showToast({ type: 'error', title: 'Generate failed', message: (e as Error).message })
    }
  }

  const addWebhook = async () => {
    if (!newWebhook.url) return
    const sub = { id: crypto.randomUUID(), event: newWebhook.event, url: newWebhook.url, secret_set: true }
    const next = { ...data, webhook_subscriptions: [...data.webhook_subscriptions, sub] }
    await settingsApi.saveSection('api_webhooks', next as never)
    setData(next)
    setNewWebhook({ event: 'email_sent', url: '' })
    showToast({ type: 'success', title: 'Webhook added' })
  }

  const removeWebhook = async (id: string) => {
    const next = { ...data, webhook_subscriptions: data.webhook_subscriptions.filter((w) => w.id !== id) }
    await settingsApi.saveSection('api_webhooks', next as never)
    setData(next)
  }

  if (!loaded) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>

  return (
    <>
      <Card title="API Key" subtitle="Use this for direct API integrations. Stored as a SHA-256 hash on the server.">
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.85rem' }}>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
            {data.api_key_last4 ? `sk_••••${data.api_key_last4}` : 'No key generated yet'}
          </span>
          {data.api_key_created_at && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
              created {new Date(data.api_key_created_at).toLocaleString()}
            </span>
          )}
        </div>
        <button className="btn btn-secondary btn-sm" onClick={generate}>
          {data.api_key_last4 ? 'Regenerate Key' : 'Generate Key'}
        </button>
        {showSecret && (
          <div style={{ marginTop: '1rem', padding: '0.85rem', background: 'var(--accent-glow)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', wordBreak: 'break-all' }}>{showSecret}</div>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: '0.5rem' }} onClick={() => { navigator.clipboard?.writeText(showSecret); showToast({ type: 'success', title: 'Copied' }) }}>Copy</button>
          </div>
        )}
      </Card>

      <Card title="Webhook Subscriptions" subtitle="Receive events as they happen. Payloads are HMAC-signed.">
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.85rem' }}>
          <select style={{ ...inputStyle, width: 180 }} value={newWebhook.event}
                  onChange={(e) => setNewWebhook({ ...newWebhook, event: e.target.value })}>
            {['email_sent','email_opened','email_clicked','email_bounced','unsubscribed','call_completed'].map((ev) => (
              <option key={ev} value={ev}>{ev}</option>
            ))}
          </select>
          <input style={inputStyle} placeholder="https://example.com/webhook" value={newWebhook.url}
                 onChange={(e) => setNewWebhook({ ...newWebhook, url: e.target.value })} />
          <button className="btn btn-primary" onClick={addWebhook}>Add</button>
        </div>
        {data.webhook_subscriptions.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon">⛓</div><div className="empty-state-title">No webhooks yet</div></div>
        ) : (
          <table>
            <thead><tr><th>Event</th><th>URL</th><th></th></tr></thead>
            <tbody>
              {data.webhook_subscriptions.map((w) => (
                <tr key={w.id}>
                  <td>{w.event}</td>
                  <td className="td-mono" style={{ wordBreak: 'break-all' }}>{w.url}</td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => removeWebhook(w.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}

// ── Coming Soon ────────────────────────────────────────────────────────────

function ComingSoon({ name }: { name: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">⌖</div>
      <div className="empty-state-title">{name} — coming soon</div>
      <div className="empty-state-body">This panel will land in a later build phase.</div>
    </div>
  )
}
