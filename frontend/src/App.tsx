// src/App.tsx
// Root application: router, layout shell, all routes
//
// Auth flow:
//   1. On mount AuthGate checks (in order):
//        a. ?token= in URL  → store in sessionStorage, strip from URL
//        b. existing sessionStorage 'icrv_token'
//        c. CF Access cookie (sent automatically as withCredentials)
//   2. It calls GET /v1/auth/me with whatever auth it has.
//        - 200 → setUser, render the app
//        - 401 → render the SignIn screen (no redirect loop)
//   3. If client.ts later sees a 401, it dispatches 'icrv:unauthorized';
//      AuthGate listens and flips back to the SignIn screen.

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

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://api.icrv.app'

type GateState = 'checking' | 'authed' | 'signin'

// ── Sign-in screen ────────────────────────────────────────────────────────────
// Minimal UI for pasting an admin JWT. The token is stored in sessionStorage
// and validated against /v1/auth/me. On success the gate flips to 'authed'.

function SignIn({ onAuthed }: { onAuthed: (user: any) => void }) {
  const [token, setToken]     = useState('')
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/v1/auth/me`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token.trim()}` },
      })
      if (!res.ok) {
        setError(`Token rejected (HTTP ${res.status}).`)
        setBusy(false)
        return
      }
      const data = await res.json()
      sessionStorage.setItem('icrv_token', token.trim())
      onAuthed(data.user)
    } catch (err: any) {
      setError(err?.message || 'Network error')
      setBusy(false)
    }
  }

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
      <form onSubmit={submit} style={{
        width: '100%',
        maxWidth: 480,
        padding: 28,
        border: '1px solid #333',
        borderRadius: 6,
        background: '#111',
      }}>
        <h1 style={{ fontSize: 18, marginBottom: 8, letterSpacing: 1 }}>
          IRON CUSTOMER REACH VMAX
        </h1>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 20 }}>
          Sign in with your admin JWT to continue.
        </p>

        <label htmlFor="icrv-token" style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
          Bearer JWT
        </label>
        <textarea
          id="icrv-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
          rows={5}
          autoFocus
          style={{
            width: '100%',
            padding: 10,
            fontFamily: 'inherit',
            fontSize: 12,
            background: '#000',
            color: '#0f0',
            border: '1px solid #333',
            borderRadius: 4,
            resize: 'vertical',
          }}
        />

        {error && (
          <div role="alert" style={{
            marginTop: 12,
            padding: 10,
            border: '1px solid #c33',
            background: '#2a0a0a',
            color: '#f88',
            fontSize: 12,
            borderRadius: 4,
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !token.trim()}
          style={{
            marginTop: 16,
            width: '100%',
            padding: 12,
            background: busy ? '#444' : '#f60',
            color: '#000',
            fontFamily: 'inherit',
            fontWeight: 700,
            border: 0,
            borderRadius: 4,
            cursor: busy ? 'wait' : 'pointer',
            letterSpacing: 1,
          }}
        >
          {busy ? 'VALIDATING…' : 'SIGN IN'}
        </button>
      </form>
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
      // 1. Pull ?token= out of the URL if present and stash it.
      const urlParams = new URLSearchParams(window.location.search)
      const urlToken  = urlParams.get('token')
      if (urlToken) {
        sessionStorage.setItem('icrv_token', urlToken)
        const cleanUrl = window.location.pathname + window.location.hash
        window.history.replaceState({}, '', cleanUrl)
      }

      const stored = sessionStorage.getItem('icrv_token')
      const headers: Record<string, string> = {}
      if (stored) headers['Authorization'] = `Bearer ${stored}`

      const res = await fetch(`${API_BASE}/v1/auth/me`, {
        credentials: 'include',
        headers,
      })

      if (res.ok) {
        const data = await res.json()
        setUser(data.user)
        setState('authed')
      } else {
        // 401 or anything else → require sign-in
        sessionStorage.removeItem('icrv_token')
        sessionStorage.removeItem('icrv_user')
        setUser(null)
        setState('signin')
      }
    } catch {
      // Network failure → still surface the sign-in screen rather than spin
      setState('signin')
    }
  }, [setUser])

  // Initial hydration on mount.
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

  if (state === 'signin') {
    return (
      <SignIn onAuthed={(u) => {
        setUser(u)
        setState('authed')
      }} />
    )
  }

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
            <Route path="/"            element={<Dashboard />} />
            <Route path="/contacts/*"  element={<Contacts />} />
            <Route path="/campaigns/*" element={<Campaigns />} />
            <Route path="/ai"          element={<AIControlPanel />} />
            <Route path="/logs"        element={<ActivityLogs />} />
            <Route path="/calls"       element={<CallMonitoring />} />
            <Route path="/settings"    element={<Settings />} />
            <Route path="*"            element={<NotFound />} />
          </Routes>
        </main>
      </div>
      <Toasts />
    </AuthGate>
  )
}
