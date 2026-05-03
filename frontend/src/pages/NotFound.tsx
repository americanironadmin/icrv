import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        textAlign: 'center',
        fontFamily: '"Space Mono", monospace',
        color: 'var(--icrv-fg, #f0f0f0)',
      }}
    >
      <h1 style={{ fontSize: 48, margin: 0, letterSpacing: 2 }}>404</h1>
      <p style={{ marginTop: 12, fontSize: 14, opacity: 0.7 }}>
        The page you requested does not exist.
      </p>
      <Link
        to="/"
        style={{
          marginTop: 24,
          padding: '10px 18px',
          border: '1px solid #f60',
          color: '#f60',
          textDecoration: 'none',
          letterSpacing: 1,
          fontSize: 12,
        }}
      >
        RETURN TO DASHBOARD
      </Link>
    </div>
  )
}
