// src/App.tsx
// Root application: router, layout shell, all routes.
//
// Auth model (post PR 6 — Cloudflare Access cutover):
//   1. The browser carries a CF_Authorization cookie set by Cloudflare Access.
//      AuthGate makes one credentials:'include' request to /v1/auth/me.
//        - 200 → setUser, render the app.
//        - 401 → render the "Sign in via Cloudflare Access" panel; the only
//                CTA navigates to the Access login URL with redirect_url back
//                to the current page.
//   2. There is no Bearer textarea, no ?token= URL ingestion, no
//      sessionStorage.icrv_token. If api/client.ts later sees a 401 (e.g.
//      cookie expired in another tab) it dispatches 'icrv:unauthorized' and
//      the gate flips back to the sign-in panel.

import React, { useEffect, useState, useCallback } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useApp } from './context/AppContext'
import Header from './components/Header'
import Sidebar from './components/Sidebar'
import Toasts from './components/Toasts'

import Dashboard      from './pages/Dashboard'
import Contacts       from './pages/Contacts'
import Campaigns      from './pages/Campaigns'
import AIControlPanel from './pages/AIControlPanel'
import ActivityLogs   from './pages/ActivityLogs'
import CallMonitoring from './pages/CallMonitoring'
import Settings       from './pages/Settings'
import NotFound       from './pages/NotFound'
import { RouteErrorBoundary } from './components/RouteErrorBoundary'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://icrv-api.americanironus.com'
const ACCESS_TEAM_DOMAIN = (import.meta.env.VITE_CF_ACCESS_TEAM_DOMAIN as string | undefined) ?? ''
const ACCESS_AUD         = (import.meta.env.VITE_CF_ACCESS_AUD as string | undefined) ?? ''

type GateState = 'checking' | 'authed' | 'signin'

function buildAccessLoginUrl(): string {
  if (!ACCESS_TEAM_DOMAIN) return '/'
  const base = `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/login`
  const path = ACCESS_AUD ? `${base}/${ACCESS_AUD}` : base
  const back = encodeURIComponent(window.location.href)
  return `${path}?redirect_url=${back}`
}

// ── Sign-in panel ────────────────────────────────────────────────────────────
// No textarea, no token paste. The only path forward is the Cloudflare Access
// login flow, after which the browser comes back here with CF_Authorization set.

function AccessSignIn() {
  const loginUrl = buildAccessLoginUrl()
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'var(--icrv-bg, #0a0a0a)',
      color: 'var(--icrv-fg, #f0f0f0)',
      fontFamily: '"Space Mono", monospace',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 440,
        padding: 28,
        border: '1px solid #333',
        borderRadius: 6,
        background: '#111',
        textAlign: 'center',
      }}>
        <h1 style={{ fontSize: 18, marginBottom: 12, letterSpacing: 1 }}>
          IRON CUSTOMER REACH VMAX
        </h1>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 24 }}>
          Sign in with your organization account to continue.
        </p>
        <a
          href={loginUrl}
          style={{
            display: 'inline-block',
            padding: '12px 28px',
            background: '#f60',
            color: '#000',
            textDecoration: 'none',
            fontWeight: 700,
            letterSpacing: 1,
            borderRadius: 4,
          }}
        >
          SIGN IN
        </a>
        {!ACCESS_TEAM_DOMAIN && (
          <p style={{ marginTop: 18, fontSize: 11, color: '#f88' }}>
            VITE_CF_ACCESS_TEAM_DOMAIN is not configured — see ENV_REFERENCE.md.
          </p>
        )}
      </div>
    </div>
  )
}

// ── Auth Gate ─────────────────────────────────────────────────────────────────

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, setUser } = useApp()
  const [state, setState] = useState<GateState>(user ? 'authed' : 'checking')

  const tryHydrate = useCallback(async () => {
    setState('checking')
    try {
      const res = await fetch(`${API_BASE}/v1/auth/me`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setUser(data.user)
        setState('authed')
      } else {
        setUser(null)
        setState('signin')
      }
    } catch {
      // Network failure — show the sign-in panel rather than spin.
      setState('signin')
    }
  }, [setUser])

  useEffect(() => {
    if (user) { setState('authed'); return }
    tryHydrate()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // React to the global 'icrv:unauthorized' event from api/client.ts.
  useEffect(() => {
    const handler = () => {
      setUser(null)
      setState('signin')
    }
    window.addEventListener('icrv:unauthorized', handler)
    return () => window.removeEventListener('icrv:unauthorized', handler)
  }, [setUser])

  if (state === 'checking') {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--icrv-bg, #0a0a0a)',
        color: 'var(--icrv-fg, #f0f0f0)',
        fontFamily: '"Space Mono", monospace',
        fontSize: 14,
        letterSpacing: 1,
      }}>
        AUTHENTICATING…
      </div>
    )
  }

  if (state === 'signin') return <AccessSignIn />

  return <>{children}</>
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <AuthGate>
      <div className="app-shell">
        <Header />
        <Sidebar />
        <main className="app-content">
          <Routes>
            <Route path="/"            element={<RouteErrorBoundary routeLabel="DASHBOARD"><Dashboard /></RouteErrorBoundary>} />
            <Route path="/contacts/*"  element={<RouteErrorBoundary routeLabel="CONTACTS"><Contacts /></RouteErrorBoundary>} />
            <Route path="/campaigns/*" element={<RouteErrorBoundary routeLabel="CAMPAIGNS"><Campaigns /></RouteErrorBoundary>} />
            <Route path="/ai"          element={<RouteErrorBoundary routeLabel="AI CONTROL"><AIControlPanel /></RouteErrorBoundary>} />
            <Route path="/logs"        element={<RouteErrorBoundary routeLabel="ACTIVITY LOGS"><ActivityLogs /></RouteErrorBoundary>} />
            <Route path="/calls"       element={<RouteErrorBoundary routeLabel="CALL MONITORING"><CallMonitoring /></RouteErrorBoundary>} />
            <Route path="/settings/*"  element={<RouteErrorBoundary routeLabel="SETTINGS"><Settings /></RouteErrorBoundary>} />
            <Route path="*"            element={<NotFound />} />
          </Routes>
        </main>
      </div>
      <Toasts />
    </AuthGate>
  )
}
