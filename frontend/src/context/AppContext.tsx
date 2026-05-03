// src/context/AppContext.tsx
// Global state: user session, AI status, toast notifications

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { agentApi, type AgentControlsResponse, type AgentControl } from '@/api/agent'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string
  email: string
  name: string
  tenant_id: string
  role: 'admin' | 'operator' | 'viewer'
}

export interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  message?: string
}

// Helper — derive a simple boolean from the real backend response.
// Agent is considered "active" when the tenant-scope control exists
// AND its kill_switch is not true.  Global kill_switch also blocks it.
export function isAgentActive(resp: AgentControlsResponse | null): boolean {
  if (!resp) return false
  const global = resp.controls.find((c: AgentControl) => c.scope === 'global')
  const tenant = resp.controls.find((c: AgentControl) => c.scope === 'tenant')
  if (global?.settings?.kill_switch) return false
  if (tenant?.settings?.kill_switch) return false
  // If no controls are set at all the agent defaults to active
  return true
}

interface AppContextValue {
  user: User | null
  setUser: (user: User | null) => void

  // Raw response from GET /v1/agent-controls
  agentControls: AgentControlsResponse | null
  agentLoading: boolean
  refreshAgentControls: () => void

  toasts: Toast[]
  showToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    const stored = sessionStorage.getItem('icrv_user')
    return stored ? (JSON.parse(stored) as User) : null
  })

  const [agentControls, setAgentControls] = useState<AgentControlsResponse | null>(null)
  const [agentLoading, setAgentLoading]   = useState(false)
  const [toasts, setToasts]               = useState<Toast[]>([])

  const setUser = useCallback((u: User | null) => {
    setUserState(u)
    if (u) sessionStorage.setItem('icrv_user', JSON.stringify(u))
    else   sessionStorage.removeItem('icrv_user')
  }, [])

  const refreshAgentControls = useCallback(async () => {
    setAgentLoading(true)
    try {
      const data = await agentApi.getControls()
      setAgentControls(data)
    } catch {
      // Non-blocking — silently skip failed polls
    } finally {
      setAgentLoading(false)
    }
  }, [])

  // Poll every 30 s
  useEffect(() => {
    refreshAgentControls()
    const id = setInterval(refreshAgentControls, 30_000)
    return () => clearInterval(id)
  }, [refreshAgentControls])

  const showToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = crypto.randomUUID()
    setToasts((prev) => [...prev, { ...toast, id }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5_000)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <AppContext.Provider
      value={{
        user, setUser,
        agentControls, agentLoading, refreshAgentControls,
        toasts, showToast, dismissToast,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
