// src/components/Toasts.tsx
import React from 'react'
import { useApp } from '@/context/AppContext'

const ICONS: Record<string, string> = {
  success: '✓',
  error:   '✕',
  warning: '⚠',
  info:    'ℹ',
}

export default function Toasts() {
  const { toasts, dismissToast } = useApp()

  if (!toasts.length) return null

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span style={{ fontSize: '0.9rem', color: `var(--${t.type === 'success' ? 'green' : t.type === 'error' ? 'red' : t.type === 'warning' ? 'yellow' : 'blue'})`, flexShrink: 0 }}>
            {ICONS[t.type]}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="toast-title">{t.title}</div>
            {t.message && <div className="toast-message">{t.message}</div>}
          </div>
          <button
            onClick={() => dismissToast(t.id)}
            className="btn btn-ghost btn-icon"
            style={{ flexShrink: 0, fontSize: '0.7rem', color: 'var(--text-muted)' }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
