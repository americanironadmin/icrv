// src/components/Header.tsx
// Top application header: app name, live API status, user profile

import React, { useEffect, useState } from 'react'
import { dashboardApi, type ApiStatus } from '@/api/dashboard'
import { useApp, isAgentActive } from '@/context/AppContext'
import { post } from '@/api/client'

const SERVICE_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  whatsapp: 'WA',
  ringcentral: 'RC',
  elevenlabs: 'EL',
}

// PR 5 / M7: never render raw upstream error strings in the operator UI —
// they can leak hostnames, stack traces, or vendor-side credential context.
function friendlyServiceError(err: string | undefined, service: string): string | undefined {
  if (!err) return undefined
  const label = SERVICE_LABELS[service] ?? service
  if (/token.*expir/i.test(err))            return `${label}: token expired — reauthorize in Settings`
  if (/quota|rate.?limit|429|too\s*many/i.test(err)) return `${label}: rate limited — retry shortly`
  if (/unauthor|forbidden|401|403/i.test(err)) return `${label}: not authorised — re-link in Settings`
  if (/timeout|timed\s*out/i.test(err))     return `${label}: timed out — retry shortly`
  return `${label}: connection error — check logs`
}

export default function Header() {
  const { user, agentControls } = useApp()
  const agentActive = isAgentActive(agentControls)
  const [services, setServices] = useState<ApiStatus[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>(
    (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') ?? 'dark'
  )

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('icrv_theme', next)
    setTheme(next)
  }

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

  // PR 6: server-side revoke + Access cookie wipe. The /v1/auth/logout response
  // carries the team-scoped logout URL so we don't have to assemble it here.
  // Fallbacks cover the case where the server hasn't been redeployed yet or
  // CF_ACCESS_TEAM_DOMAIN isn't set in either layer.
  const logout = async () => {
    try {
      const data = await post<{ ok: boolean; logout_url: string | null }>('/v1/auth/logout')
      if (data.logout_url) { window.location.href = data.logout_url; return }
    } catch {
      // Fall through to the legacy env-derived URL.
    }
    const team = (import.meta.env.VITE_CF_ACCESS_TEAM_DOMAIN as string | undefined)
              ?? (import.meta.env.VITE_CF_ACCESS_TEAM as string | undefined)
    window.location.href = team
      ? `https://${team.includes('.') ? team : `${team}.cloudflareaccess.com`}/cdn-cgi/access/logout`
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
            title={friendlyServiceError(svc.error, svc.service) ?? (svc.connected ? 'Connected' : 'Disconnected')}
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
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          style={{ color: 'var(--text-muted)' }}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
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
