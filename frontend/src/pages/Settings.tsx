// src/pages/Settings.tsx
// Integration settings: WhatsApp Business, ElevenLabs agent + phone, status of
// Gmail and RingCentral. Calls /v1/admin/integrations/* on icrv-api.

import React, { useEffect, useState, useCallback } from 'react'
import { adminApi, type IntegrationsState } from '@/api/admin'
import { useApp } from '@/context/AppContext'

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 10, height: 10, borderRadius: '50%',
      background: ok ? '#0c0' : '#c33',
      marginRight: 8, verticalAlign: 'middle',
    }} />
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      border: '1px solid #333',
      borderRadius: 6,
      padding: 20,
      background: '#111',
      marginBottom: 24,
    }}>
      <h2 style={{ fontSize: 14, letterSpacing: 1, marginBottom: 16, color: '#f60' }}>{title}</h2>
      {children}
    </section>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 10,
  fontFamily: '"Space Mono", monospace',
  fontSize: 12,
  background: '#000',
  color: '#0f0',
  border: '1px solid #333',
  borderRadius: 4,
  marginTop: 4,
  marginBottom: 12,
}
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, color: '#aaa', marginTop: 8, letterSpacing: 0.5 }
const buttonStyle: React.CSSProperties = {
  padding: '10px 20px',
  background: '#f60',
  color: '#000',
  fontFamily: '"Space Mono", monospace',
  fontWeight: 700,
  border: 0,
  borderRadius: 4,
  cursor: 'pointer',
  letterSpacing: 1,
}

export default function Settings() {
  const { showToast } = useApp()
  const [state, setState] = useState<IntegrationsState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // WhatsApp form fields
  const [waPhoneNumberId, setWaPhoneNumberId] = useState('')
  const [waBusinessId, setWaBusinessId] = useState('')
  const [waAccessToken, setWaAccessToken] = useState('')
  const [waBusy, setWaBusy] = useState(false)

  // ElevenLabs form fields
  const [elAgentId, setElAgentId] = useState('')
  const [elPhoneNumberId, setElPhoneNumberId] = useState('')
  const [elBusy, setElBusy] = useState(false)

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
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load integrations')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const submitWhatsApp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!waPhoneNumberId.trim() || !waAccessToken.trim()) {
      showToast({ type: 'error', title: 'WhatsApp', message: 'phone_number_id and access_token are required' })
      return
    }
    setWaBusy(true)
    try {
      await adminApi.saveWhatsApp({
        phone_number_id: waPhoneNumberId.trim(),
        business_id:     waBusinessId.trim(),
        access_token:    waAccessToken.trim(),
      })
      showToast({ type: 'success', title: 'WhatsApp saved', message: `Credential stored for ${waPhoneNumberId.trim()}` })
      setWaAccessToken('') // clear secret from memory after save
      await refresh()
    } catch (e: any) {
      showToast({ type: 'error', title: 'WhatsApp save failed', message: e?.response?.data?.detail ?? e?.message ?? 'Unknown error' })
    } finally {
      setWaBusy(false)
    }
  }

  const submitElevenLabs = async (e: React.FormEvent) => {
    e.preventDefault()
    const agentId = elAgentId.trim()
    const phoneId = elPhoneNumberId.trim()
    if (!agentId && !phoneId) {
      showToast({ type: 'error', title: 'ElevenLabs', message: 'agent_id or phone_number_id required' })
      return
    }
    setElBusy(true)
    try {
      await adminApi.saveElevenLabs({
        agent_id: agentId || undefined,
        phone_number_id: phoneId || undefined,
      })
      showToast({ type: 'success', title: 'ElevenLabs saved', message: `Agent ${agentId || '(unchanged)'}, phone ${phoneId || '(unchanged)'}` })
      await refresh()
    } catch (e: any) {
      showToast({ type: 'error', title: 'ElevenLabs save failed', message: e?.response?.data?.detail ?? e?.message ?? 'Unknown error' })
    } finally {
      setElBusy(false)
    }
  }

  if (loading && !state) {
    return <div style={{ padding: 40, color: '#aaa' }}>LOADING INTEGRATIONS…</div>
  }
  if (error) {
    return <div style={{ padding: 40, color: '#f88' }}>Error: {error}</div>
  }
  if (!state) return null

  return (
    <div style={{ padding: 24, maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, letterSpacing: 1, marginBottom: 4 }}>SETTINGS</h1>
      <p style={{ color: '#aaa', fontSize: 13, marginBottom: 28 }}>
        Configure third-party integrations. Changes take effect immediately — no redeploy needed.
      </p>

      {/* ── Status overview ─────────────────────────────────────── */}
      <Card title="CURRENT STATUS">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, fontSize: 13 }}>
          <div><StatusDot ok={state.gmail.connected} />Gmail {state.gmail.email ? `— ${state.gmail.email}` : '(not connected)'}</div>
          <div><StatusDot ok={state.whatsapp.connected} />WhatsApp {state.whatsapp.metadata.phone_number_id ? `— ${state.whatsapp.metadata.phone_number_id}` : '(not configured)'}</div>
          <div><StatusDot ok={state.ringcentral.connected} />RingCentral {state.ringcentral.label ?? ''}</div>
          <div><StatusDot ok={state.elevenlabs.connected} />ElevenLabs {state.elevenlabs.agent_id ?? '(no agent)'}</div>
        </div>
      </Card>

      {/* ── WhatsApp Business ───────────────────────────────────── */}
      <Card title="WHATSAPP BUSINESS (META)">
        <p style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          Get these from <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" style={{ color: '#f60' }}>Meta App Dashboard</a> → WhatsApp → API Setup.
          The access token is encrypted at rest with envelope encryption.
        </p>
        <form onSubmit={submitWhatsApp}>
          <label style={labelStyle}>Phone Number ID *</label>
          <input style={inputStyle} value={waPhoneNumberId} onChange={(e) => setWaPhoneNumberId(e.target.value)} placeholder="e.g. 123456789012345" />

          <label style={labelStyle}>Business Account ID</label>
          <input style={inputStyle} value={waBusinessId} onChange={(e) => setWaBusinessId(e.target.value)} placeholder="optional" />

          <label style={labelStyle}>Permanent Access Token *</label>
          <input style={inputStyle} type="password" value={waAccessToken} onChange={(e) => setWaAccessToken(e.target.value)} placeholder="EAAxxxxxx... (token is hidden after save)" />

          <button type="submit" disabled={waBusy} style={{ ...buttonStyle, opacity: waBusy ? 0.6 : 1, cursor: waBusy ? 'wait' : 'pointer' }}>
            {waBusy ? 'SAVING…' : 'SAVE WHATSAPP'}
          </button>
        </form>
      </Card>

      {/* ── ElevenLabs Agent + Phone ────────────────────────────── */}
      <Card title="ELEVENLABS VOICE AGENT">
        <p style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          Tell the system which agent to use and which phone number is attached to it.
          Get the phone number ID from <a href="https://elevenlabs.io/app/agents" target="_blank" rel="noreferrer" style={{ color: '#f60' }}>ElevenLabs Conversational AI</a> → Phone Numbers.
        </p>
        <form onSubmit={submitElevenLabs}>
          <label style={labelStyle}>Agent ID</label>
          <input style={inputStyle} value={elAgentId} onChange={(e) => setElAgentId(e.target.value)} placeholder="agent_xxxxxxxxxxxxxxxx" />

          <label style={labelStyle}>Agent Phone Number ID</label>
          <input style={inputStyle} value={elPhoneNumberId} onChange={(e) => setElPhoneNumberId(e.target.value)} placeholder="phnum_xxxxxxxxxxxxxxxx (required for outbound calls)" />

          <button type="submit" disabled={elBusy} style={{ ...buttonStyle, opacity: elBusy ? 0.6 : 1, cursor: elBusy ? 'wait' : 'pointer' }}>
            {elBusy ? 'SAVING…' : 'SAVE ELEVENLABS'}
          </button>
        </form>
      </Card>
    </div>
  )
}
