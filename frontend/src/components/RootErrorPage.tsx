// frontend/src/components/RootErrorPage.tsx
// Last-resort error UI rendered by the top-level Sentry.ErrorBoundary. Surfaces
// the Sentry event ID so an operator can quote it when paging support.

import * as Sentry from '@sentry/react'

export function RootErrorPage({ eventId, resetError }: { eventId?: string; resetError?: () => void }) {
  const id = eventId ?? Sentry.lastEventId() ?? 'no-event-id'
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        background: 'var(--icrv-bg, #0a0a0a)',
        color: 'var(--icrv-fg, #f0f0f0)',
        fontFamily: '"Space Mono", monospace',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 24, letterSpacing: 2, margin: 0 }}>ICRV CRASHED</h1>
      <p style={{ marginTop: 16, opacity: 0.75, maxWidth: 480 }}>
        The dashboard hit an unrecoverable error. The event has been reported.
      </p>
      <code
        style={{
          marginTop: 16,
          padding: '6px 10px',
          border: '1px solid #333',
          background: '#111',
          fontSize: 12,
          letterSpacing: 1,
        }}
      >
        event_id: {id}
      </code>
      {resetError && (
        <button
          type="button"
          onClick={resetError}
          style={{
            marginTop: 24,
            padding: '10px 18px',
            background: '#f60',
            color: '#000',
            border: 0,
            fontFamily: 'inherit',
            fontWeight: 700,
            letterSpacing: 1,
            cursor: 'pointer',
          }}
        >
          TRY AGAIN
        </button>
      )}
    </div>
  )
}
