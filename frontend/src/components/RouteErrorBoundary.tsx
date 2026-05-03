// frontend/src/components/RouteErrorBoundary.tsx
// Per-route error boundary. A render throw inside one page no longer blanks
// the whole shell — the user sees a localised "Something went wrong" panel
// and can retry without reloading. Sentry captures the error if PR 4's DSN
// is set.

import { ReactNode } from 'react'
import * as Sentry from '@sentry/react'

interface Props {
  routeLabel: string
  children: ReactNode
}

export function RouteErrorBoundary({ routeLabel, children }: Props) {
  return (
    <Sentry.ErrorBoundary
      fallback={({ resetError, eventId }) => (
        <div
          style={{
            padding: '2rem',
            margin: '2rem auto',
            maxWidth: 560,
            border: '1px solid #c33',
            background: '#1a0a0a',
            color: '#f0f0f0',
            fontFamily: '"Space Mono", monospace',
            textAlign: 'center',
          }}
        >
          <h2 style={{ fontSize: 18, letterSpacing: 1, margin: 0 }}>
            {routeLabel}: SOMETHING WENT WRONG
          </h2>
          <p style={{ marginTop: 12, opacity: 0.75, fontSize: 13 }}>
            This view crashed. Other parts of the dashboard still work.
          </p>
          {eventId && (
            <code style={{ display: 'block', marginTop: 12, fontSize: 11, opacity: 0.6 }}>
              event_id: {eventId}
            </code>
          )}
          <button
            type="button"
            onClick={resetError}
            style={{
              marginTop: 18,
              padding: '8px 16px',
              background: '#f60',
              color: '#000',
              border: 0,
              fontFamily: 'inherit',
              fontWeight: 700,
              letterSpacing: 1,
              cursor: 'pointer',
            }}
          >
            RETRY
          </button>
        </div>
      )}
      showDialog={false}
    >
      {children}
    </Sentry.ErrorBoundary>
  )
}
