// src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import { AppProvider } from './context/AppContext'
import App from './App'
import { RootErrorPage } from './components/RootErrorPage'
import { scrubPii } from './lib/sentry-scrub'
import './index.css'

// Theme bootstrap — saved choice wins; otherwise honour the OS preference.
// Runs before React mounts so there's no flash of opposite theme.
const savedTheme = localStorage.getItem('icrv_theme')
const initialTheme = savedTheme === 'light' || savedTheme === 'dark'
  ? savedTheme
  : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
document.documentElement.setAttribute('data-theme', initialTheme)

// Sentry init — opt-in: if VITE_SENTRY_DSN is empty the SDK stays dormant and
// errors fall through to the browser console as before. PII and auth tokens
// are stripped from every outbound event by scrubPii.
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
if (dsn) {
  Sentry.init({
    dsn,
    environment: (import.meta.env.MODE ?? 'production') as string,
    release: (import.meta.env.VITE_BUILD_SHA as string | undefined) ?? undefined,
    tracesSampleRate: 0.1,
    // Session replay intentionally disabled by default — this app handles PII.
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 1.0,
    sendDefaultPii: false,
    beforeSend: scrubPii,
    beforeSendTransaction: scrubPii,
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <Sentry.ErrorBoundary
          fallback={({ eventId, resetError }) => (
            <RootErrorPage eventId={eventId} resetError={resetError} />
          )}
          showDialog={false}
        >
          <App />
        </Sentry.ErrorBoundary>
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>
)
