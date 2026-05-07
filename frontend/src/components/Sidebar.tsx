// src/components/Sidebar.tsx
// Left navigation with active route highlighting

import React from 'react'
import { NavLink, useLocation } from 'react-router-dom'

interface NavItem {
  path: string
  icon: string
  label: string
  sublabel?: string
}

const NAV_ITEMS: NavItem[] = [
  { path: '/',        icon: '⬡', label: 'Dashboard',   sublabel: 'Overview' },
  { path: '/contacts',icon: '◈', label: 'Contacts',    sublabel: 'CRM' },
  { path: '/campaigns',icon:'▶', label: 'Campaigns',   sublabel: 'Outreach' },
  { path: '/ai',      icon: '◉', label: 'AI Control',  sublabel: 'Agent' },
  { path: '/logs',    icon: '≡', label: 'Activity',    sublabel: 'Logs' },
  { path: '/calls',   icon: '◎', label: 'Call Monitor',sublabel: 'Voice' },
  { path: '/leads',   icon: '◆', label: 'Leads',       sublabel: 'Intelligence' },
  { path: '/analytics',icon:'∞', label: 'Analytics',   sublabel: 'Insights' },
  { path: '/templates',icon:'▤', label: 'Templates',   sublabel: 'Library' },
  { path: '/regional',icon: '◯', label: 'Regional',    sublabel: 'ME Outreach' },
  { path: '/whatsapp/quotes',icon:'◐', label: 'WA Quotes', sublabel: 'Coming soon' },
  { path: '/settings',icon: '⚙', label: 'Settings',    sublabel: 'Workspace' },
]

export default function Sidebar() {
  const location = useLocation()

  return (
    <aside className="app-sidebar">
      {/* Section: Main */}
      <div style={{ padding: '1.25rem 0.75rem 0.5rem' }}>
        <div className="section-label" style={{ paddingLeft: '0.5rem' }}>
          Navigation
        </div>
      </div>

      <nav>
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.path === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(item.path)

          return (
            <NavLink
              key={item.path}
              to={item.path}
              style={{ textDecoration: 'none' }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.65rem 1rem',
                  margin: '0 0.5rem',
                  borderRadius: 'var(--radius-md)',
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: 'pointer',
                  transition: 'all 0.12s',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                <span
                  style={{
                    fontSize: '0.9rem',
                    color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                    flexShrink: 0,
                    width: '18px',
                    textAlign: 'center',
                  }}
                >
                  {item.icon}
                </span>
                <div>
                  <div
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontSize: '0.65rem',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.06em',
                    }}
                  >
                    {item.sublabel}
                  </div>
                </div>
              </div>
            </NavLink>
          )
        })}
      </nav>

      {/* Bottom section: system info */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '1rem',
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6rem',
            color: 'var(--text-muted)',
            letterSpacing: '0.06em',
            textAlign: 'center',
          }}
        >
          ICRV {import.meta.env.VITE_BUILD_SHA ?? 'dev'} · CF Workers
        </div>
      </div>
    </aside>
  )
}
