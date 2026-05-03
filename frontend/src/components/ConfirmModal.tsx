// frontend/src/components/ConfirmModal.tsx
// PR 7 / L5: type-to-confirm modal for destructive actions. The action button
// stays disabled until the operator types the exact confirmation word, which
// blocks accidental clicks on kill-switch / bulk-delete / run-reject.

import { useState } from 'react'

interface Props {
  open: boolean
  title: string
  body?: string
  /** Word the operator must type to enable the action button. */
  confirmWord: string
  confirmLabel?: string
  onConfirm: () => void | Promise<void>
  onClose: () => void
  /** Visual treatment — destructive actions get the red CTA. */
  tone?: 'destructive' | 'warning'
}

export function ConfirmModal({
  open, title, body, confirmWord,
  confirmLabel, onConfirm, onClose, tone = 'destructive',
}: Props) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy]   = useState(false)
  if (!open) return null

  const enabled = typed.trim() === confirmWord
  const accent = tone === 'destructive' ? '#ef4444' : '#f59e0b'

  const submit = async () => {
    if (!enabled || busy) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      setTyped('')
    }
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-header">
          <h3
            id="confirm-modal-title"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.05rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: accent,
            }}
          >
            {title}
          </h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {body && (
            <p style={{ marginBottom: '1rem', fontSize: 13, color: 'var(--text-secondary)' }}>
              {body}
            </p>
          )}
          <label
            htmlFor="confirm-input"
            style={{
              display: 'block',
              fontSize: 12,
              marginBottom: 6,
              color: 'var(--text-muted)',
              letterSpacing: '0.06em',
            }}
          >
            Type <code style={{ color: accent, fontWeight: 700 }}>{confirmWord}</code> to confirm
          </label>
          <input
            id="confirm-input"
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            style={{
              width: '100%',
              padding: '10px 12px',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              background: 'var(--bg-base)',
              color: 'var(--text-primary)',
              border: `1px solid ${enabled ? accent : 'var(--border-strong)'}`,
              borderRadius: 4,
            }}
          />
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '1rem' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            disabled={!enabled || busy}
            onClick={submit}
            style={{
              padding: '8px 16px',
              background: enabled && !busy ? accent : '#444',
              color: '#000',
              border: 0,
              fontFamily: 'inherit',
              fontWeight: 700,
              letterSpacing: 1,
              cursor: enabled && !busy ? 'pointer' : 'not-allowed',
              borderRadius: 4,
            }}
          >
            {busy ? 'WORKING…' : (confirmLabel ?? 'CONFIRM')}
          </button>
        </div>
      </div>
    </div>
  )
}
