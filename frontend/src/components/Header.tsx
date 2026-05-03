// src/components/Header.tsx
// Top application header: app name, live API status, user profile

import React, { useEffect, useState } from 'react'
import { dashboardApi, type ApiStatus } from '@/api/dashboard'
import { useApp, isAgentActive } from '@/context/AppContext'

const SERVICE_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  whatsapp: 'WA',
  ringcentral: 'RC',
  elevenlabs: 'EL',
}

export default function Header() {
  const { user, agentControls } = useApp()
  const agentActive = isAgentActive(agentControls)
  const [services, setServices] = useState<ApiStatus[]>([])

  useEffect(() => {
    const load = async () => {
      try {
        const res = await dashboardApi.getServiceStatus()
        setServices(res.services)
      } catch {
        // Non-fatal
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [])

  const logout = () => {
    sessionStorage.clear()
    // Cloudflare Access logout endpoint
    const team = import.meta.env.VITE_CF_ACCESS_TEAM ?? ''
    window.location.href = team
      ? `https://${team}.cloudflareaccess.com/cdn-cgi/access/logout`
      : '/'
  }

  return (
    <header className="app-header">
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flex: '0 0 auto' }}>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.1rem',
            fontWeight: 800,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
          }}
        >
          IRON
        </span>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '0.72rem',
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
          }}
        >
          Customer Reach VMAX
        </span>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* AI Agent pill */}
      {agentControls && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.25rem 0.75rem',
            background: agentActive ? 'var(--accent-glow)' : 'var(--bg-hover)',
            border: `1px solid ${agentActive ? 'rgba(245,158,11,0.4)' : 'var(--border-default)'}`,
            borderRadius: '2px',
          }}
        >
          <span
            className="status-dot"
            style={{
              background: agentActive ? 'var(--accent)' : 'var(--text-muted)',
              boxShadow: agentActive ? '0 0 6px var(--accent)' : 'none',
              animation: agentActive ? 'pulse 2s infinite' : 'none',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              color: agentActive ? 'var(--accent)' : 'var(--text-muted)',
              letterSpacing: '0.06em',
            }}
          >
            AI {agentActive ? 'ACTIVE' : 'OFF'}
          </span>
        </div>
      )}

      {/* API Status indicators */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {services.map((svc) => (
          <div
            key={svc.service}
            title={svc.error ?? (svc.connected ? 'Connected' : 'Disconnected')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              padding: '0.2rem 0.5rem',
              borderRadius: '2px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              cursor: 'default',
            }}
          >
            <span
              className={`status-dot ${svc.connected ? 'live' : 'error'}`}
              style={{ width: '5px', height: '5px', animation: svc.connected ? 'pulse 2s infinite' : 'none' }}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.62rem',
                color: svc.connected ? 'var(--green)' : 'var(--red)',
                letterSpacing: '0.06em',
              }}
            >
              {SERVICE_LABELS[svc.service] ?? svc.service.toUpperCase()}
            </span>
          </div>
        ))}
      </div>

      {/* User */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-primary)', fontWeight: 500 }}>
            {user?.name ?? 'Operator'}
          </div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {user?.role?.toUpperCase() ?? 'USER'}
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={logout}
          style={{ color: 'var(--text-muted)' }}
        >
          ⎋ Logout
        </button>
      </div>
    </header>
  )
}
