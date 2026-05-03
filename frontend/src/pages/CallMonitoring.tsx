// src/pages/CallMonitoring.tsx
// Real-time call monitoring — polls /v1/calls/active every 5 seconds
// Displays active calls with VoiceSessionDO state: speaker, duration, transcript

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { callsApi, type ActiveCall, type CallLog, type TranscriptSegment } from '@/api/calls'
import { useApp } from '@/context/AppContext'
import { formatDistanceToNow, format } from 'date-fns'

// ── Duration formatter ────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ── Speaker Indicator ─────────────────────────────────────────────────────────

function SpeakerIndicator({ state, direction }: { state: ActiveCall['speaker_state']; direction: 'inbound' | 'outbound' }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      {/* AI Speaker */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.25rem 0.6rem',
        borderRadius: '2px',
        background: state === 'ai_speaking' ? 'var(--accent-glow)' : 'var(--bg-base)',
        border: `1px solid ${state === 'ai_speaking' ? 'rgba(245,158,11,0.4)' : 'var(--border-subtle)'}`,
        transition: 'all 0.3s',
      }}>
        <span style={{
          fontSize: '0.6rem',
          fontFamily: 'var(--font-mono)',
          color: state === 'ai_speaking' ? 'var(--accent)' : 'var(--text-muted)',
          letterSpacing: '0.06em',
        }}>
          AI
        </span>
        {state === 'ai_speaking' && (
          <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '12px' }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  width: '3px',
                  background: 'var(--accent)',
                  borderRadius: '1px',
                  animation: `waveBar ${0.8 + i * 0.15}s ease-in-out infinite`,
                  animationDelay: `${i * 0.1}s`,
                  height: state === 'ai_speaking' ? '100%' : '30%',
                }}
              />
            ))}
          </div>
        )}
      </div>

      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>↔</span>

      {/* Contact Speaker */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.25rem 0.6rem',
        borderRadius: '2px',
        background: state === 'contact_speaking' ? 'var(--green-dim)' : 'var(--bg-base)',
        border: `1px solid ${state === 'contact_speaking' ? 'rgba(16,185,129,0.3)' : 'var(--border-subtle)'}`,
        transition: 'all 0.3s',
      }}>
        <span style={{
          fontSize: '0.6rem',
          fontFamily: 'var(--font-mono)',
          color: state === 'contact_speaking' ? 'var(--green)' : 'var(--text-muted)',
          letterSpacing: '0.06em',
        }}>
          CONTACT
        </span>
        {state === 'contact_speaking' && (
          <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '12px' }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  width: '3px',
                  background: 'var(--green)',
                  borderRadius: '1px',
                  animation: `waveBar ${0.7 + i * 0.2}s ease-in-out infinite`,
                  animationDelay: `${i * 0.15}s`,
                  height: '100%',
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Active Call Card ──────────────────────────────────────────────────────────

function ActiveCallCard({ call, onSelect, selected }: { call: ActiveCall; onSelect: () => void; selected: boolean }) {
  const statusColors: Record<string, string> = {
    queued:    'var(--text-muted)',
    ringing:   'var(--yellow)',
    connected: 'var(--green)',
    ended:     'var(--text-muted)',
    failed:    'var(--red)',
  }

  return (
    <div
      onClick={onSelect}
      style={{
        background: selected ? 'var(--bg-active)' : 'var(--bg-elevated)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '1rem',
        cursor: 'pointer',
        transition: 'all 0.15s',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Status bar */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: '2px',
        background: statusColors[call.status] ?? 'var(--text-muted)',
      }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>{call.contact_name}</div>
          <div className="text-xs font-mono text-muted">{call.contact_phone}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`badge ${call.status === 'connected' ? 'badge-green' : call.status === 'ringing' ? 'badge-yellow' : 'badge-gray'}`}>
            {call.status}
          </span>
          <div className="text-xs font-mono" style={{ color: 'var(--accent)', marginTop: '0.25rem' }}>
            {formatDuration(call.duration_seconds)}
          </div>
        </div>
      </div>

      <SpeakerIndicator state={call.speaker_state} direction={call.direction} />

      {call.transcript_preview && (
        <div style={{
          marginTop: '0.75rem',
          padding: '0.5rem',
          background: 'var(--bg-base)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          fontStyle: 'italic',
          borderLeft: '2px solid var(--border-strong)',
        }}>
          "{call.transcript_preview}"
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
        <span className={`badge ${call.direction === 'outbound' ? 'badge-blue' : 'badge-purple'}`}>{call.direction}</span>
        {call.campaign_name && <span className="badge badge-gray">{call.campaign_name}</span>}
        <span className="text-xs text-muted font-mono" style={{ marginLeft: 'auto' }}>
          {formatDistanceToNow(new Date(call.started_at), { addSuffix: true })}
        </span>
      </div>
    </div>
  )
}

// ── Call Detail: Transcript ───────────────────────────────────────────────────

function CallTranscript({ callId }: { callId: string }) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [loading, setLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await callsApi.getTranscript(callId)
      setSegments(res.segments)
    } catch {
      // May not be available yet
    } finally {
      setLoading(false)
    }
  }, [callId])

  useEffect(() => {
    load()
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [segments])

  if (loading && segments.length === 0) {
    return <div className="skeleton" style={{ height: '120px', margin: '0.5rem 0' }} />
  }

  return (
    <div style={{
      maxHeight: '320px',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
      padding: '0.5rem 0',
    }}>
      {segments.length === 0 ? (
        <div className="text-xs text-muted" style={{ textAlign: 'center', padding: '1rem' }}>
          Transcript will appear as the call progresses…
        </div>
      ) : (
        segments.map((seg, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: seg.speaker === 'ai' ? 'flex-start' : 'flex-end',
            }}
          >
            <div style={{
              maxWidth: '80%',
              padding: '0.5rem 0.75rem',
              borderRadius: 'var(--radius-md)',
              background: seg.speaker === 'ai' ? 'var(--accent-glow)' : 'var(--bg-hover)',
              border: `1px solid ${seg.speaker === 'ai' ? 'rgba(245,158,11,0.2)' : 'var(--border-subtle)'}`,
              fontSize: '0.82rem',
              color: 'var(--text-primary)',
              lineHeight: 1.5,
            }}>
              <div style={{
                fontSize: '0.6rem',
                fontFamily: 'var(--font-mono)',
                color: seg.speaker === 'ai' ? 'var(--accent)' : 'var(--text-muted)',
                marginBottom: '0.2rem',
                letterSpacing: '0.08em',
              }}>
                {seg.speaker === 'ai' ? 'AI AGENT' : 'CONTACT'} · {Math.floor(seg.timestamp_ms / 1000)}s
              </div>
              {seg.text}
            </div>
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  )
}

// ── Recent Calls Table ────────────────────────────────────────────────────────

function RecentCallsTable() {
  const [calls, setCalls] = useState<CallLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    try {
      const res = await callsApi.list({ page, per_page: 15, sort: 'desc' as never })
      setCalls(res.calls)
      setTotal(res.total)
    } catch {
      // interceptor handles
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => { load() }, [load])

  const totalPages = Math.ceil(total / 15)

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="card-header" style={{ padding: '0.75rem 1rem' }}>
        <span className="card-title">Recent Calls</span>
        <span className="text-xs text-muted font-mono">{total} total</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contact</th>
              <th>Direction</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Outcome</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 6 }).map((_, j) => <td key={j}><div className="skeleton" style={{ height: '12px' }} /></td>)}</tr>
              ))
            ) : calls.length === 0 ? (
              <tr><td colSpan={6}><div className="empty-state"><div className="empty-state-icon">◎</div><div className="empty-state-title">No call history</div></div></td></tr>
            ) : (
              calls.map((c) => (
                <tr key={c.id}>
                  <td className="td-name">
                    {c.contact_name ?? '—'}
                    <div className="text-xs font-mono text-muted">{c.id.substring(0, 8)}…</div>
                  </td>
                  <td><span className={`badge ${c.direction === 'outbound' ? 'badge-blue' : 'badge-purple'}`}>{c.direction}</span></td>
                  <td>
                    <span className={`badge ${['connected', 'ended'].includes(c.status) ? 'badge-green' : c.status === 'failed' ? 'badge-red' : c.status === 'voicemail' ? 'badge-yellow' : 'badge-gray'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="td-mono">{c.duration_seconds ? formatDuration(c.duration_seconds) : '—'}</td>
                  <td className="text-xs text-muted">{c.outcome ?? '—'}</td>
                  <td className="td-mono text-xs">{formatDistanceToNow(new Date(c.started_at), { addSuffix: true })}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border-subtle)' }}>
        <div className="pagination">
          <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{page} / {Math.max(1, totalPages)}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next →</button>
        </div>
      </div>
    </div>
  )
}

// ── Main Call Monitoring Page ─────────────────────────────────────────────────

export default function CallMonitoring() {
  const { showToast } = useApp()
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([])
  const [selectedCall, setSelectedCall] = useState<ActiveCall | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date())

  const loadActive = useCallback(async () => {
    try {
      const res = await callsApi.getActive()
      setActiveCalls(res.calls)
      setLastUpdated(new Date())
      // Update selected call data if it exists
      if (selectedCall) {
        const updated = res.calls.find((c) => c.id === selectedCall.id)
        if (updated) setSelectedCall(updated)
        else if (!res.calls.some((c) => c.id === selectedCall.id)) {
          // Call ended — keep showing it but mark ended
        }
      }
    } catch {
      // Non-blocking
    } finally {
      setLoading(false)
    }
  }, [selectedCall])

  useEffect(() => {
    loadActive()
    const id = setInterval(loadActive, 5_000) // 5s poll for real-time
    return () => clearInterval(id)
  }, [loadActive])

  const endCall = async (callId: string) => {
    try {
      await callsApi.endCall(callId)
      showToast({ type: 'info', title: 'End call requested' })
      loadActive()
    } catch {
      showToast({ type: 'error', title: 'Failed to end call' })
    }
  }

  return (
    <div>
      {/* Wave animation */}
      <style>{`
        @keyframes waveBar {
          0%, 100% { transform: scaleY(0.3); }
          50%       { transform: scaleY(1.0); }
        }
      `}</style>

      <div className="page-header">
        <div>
          <h1 className="page-title">Call Monitoring</h1>
          <p className="page-subtitle">
            {activeCalls.length > 0 ? (
              <span style={{ color: 'var(--green)' }}>
                {activeCalls.length} active call{activeCalls.length !== 1 ? 's' : ''} · Live
              </span>
            ) : (
              'No active calls'
            )} · Updated {formatDistanceToNow(lastUpdated, { addSuffix: true })}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="status-dot live" />
          <span style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>
            POLLING 5s
          </span>
        </div>
      </div>

      {/* Active Calls Grid */}
      {loading && activeCalls.length === 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: '160px', borderRadius: 'var(--radius-lg)' }} />
          ))}
        </div>
      ) : activeCalls.length === 0 ? (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="empty-state">
            <div className="empty-state-icon" style={{ fontSize: '3rem' }}>◎</div>
            <div className="empty-state-title">No Active Calls</div>
            <p className="text-sm">Active calls will appear here in real-time as they are initiated</p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: selectedCall ? '1fr 420px' : 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem', alignContent: 'start' }}>
            {activeCalls.map((call) => (
              <ActiveCallCard
                key={call.id}
                call={call}
                selected={selectedCall?.id === call.id}
                onSelect={() => setSelectedCall(selectedCall?.id === call.id ? null : call)}
              />
            ))}
          </div>

          {/* Call Detail + Transcript */}
          {selectedCall && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Live Session</span>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  {selectedCall.status === 'connected' && (
                    <button className="btn btn-danger btn-sm" onClick={() => endCall(selectedCall.id)}>
                      End Call
                    </button>
                  )}
                  <button className="btn btn-ghost btn-icon" onClick={() => setSelectedCall(null)}>✕</button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>{selectedCall.contact_name}</div>
                  <div className="text-xs font-mono text-muted">{selectedCall.contact_phone}</div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span className={`badge ${selectedCall.status === 'connected' ? 'badge-green' : 'badge-yellow'}`}>{selectedCall.status}</span>
                  <span className={`badge ${selectedCall.direction === 'outbound' ? 'badge-blue' : 'badge-purple'}`}>{selectedCall.direction}</span>
                  <span className="badge badge-accent" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.06em' }}>
                    {formatDuration(selectedCall.duration_seconds)}
                  </span>
                </div>

                <SpeakerIndicator state={selectedCall.speaker_state} direction={selectedCall.direction} />

                {selectedCall.rc_session_id && (
                  <div className="text-xs text-muted font-mono">
                    RC Session: {selectedCall.rc_session_id}
                  </div>
                )}

                <div className="divider" />

                <div className="section-label">Live Transcript</div>
                <CallTranscript callId={selectedCall.id} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recent Calls History */}
      <RecentCallsTable />
    </div>
  )
}
