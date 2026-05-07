// src/pages/WhatsAppQuotes.tsx — Phase 5 stub (no backend yet).

import React from 'react'

export default function WhatsAppQuotes() {
  return (
    <div style={{ padding: '1.5rem', maxWidth: 720 }}>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>WhatsApp Quotes</h1>
      <div style={{
        marginTop: '2rem',
        padding: '2.5rem',
        background: 'var(--bg-surface)',
        border: '1px dashed var(--border-strong)',
        borderRadius: 'var(--radius-lg)',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '2.5rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>⌖</div>
        <div style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '1rem', color: 'var(--text-secondary)' }}>Coming soon</div>
        <p style={{ marginTop: '0.85rem', color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5 }}>
          Quoting workflows over WhatsApp will land once we agree on the conversation
          shape (price-list lookup, quote-id ingestion, follow-up automation).
        </p>
      </div>
    </div>
  )
}
