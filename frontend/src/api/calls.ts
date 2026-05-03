// src/api/calls.ts
// Real calls to icrv-api /v1/calls endpoints
// Backed by VoiceSessionDO and RingCentral webhook data

import { get, post } from './client'

export type CallStatus = 'queued' | 'ringing' | 'connected' | 'ended' | 'failed' | 'voicemail' | 'no_answer'
export type CallDirection = 'inbound' | 'outbound'
export type SpeakerState = 'ai_speaking' | 'contact_speaking' | 'silence' | 'unknown'

export interface ActiveCall {
  id: string
  tenant_id: string
  contact_id: string
  contact_name: string
  contact_phone: string
  campaign_id?: string
  campaign_name?: string
  direction: CallDirection
  status: CallStatus
  correlation_id: string
  rc_session_id?: string
  el_conversation_id?: string
  duration_seconds: number
  speaker_state: SpeakerState
  transcript_preview?: string
  started_at: string
  answered_at?: string
  ended_at?: string
  outcome?: string
}

export interface CallLog {
  id: string
  tenant_id: string
  contact_id: string
  contact_name?: string
  campaign_id?: string
  direction: CallDirection
  status: CallStatus
  duration_seconds?: number
  correlation_id: string
  outcome?: string
  recording_url?: string
  transcript_url?: string
  started_at: string
  ended_at?: string
  created_at: string
}

export interface CallsListResponse {
  calls: CallLog[]
  total: number
  page: number
  per_page: number
}

export interface ActiveCallsResponse {
  calls: ActiveCall[]
  count: number
}

export const callsApi = {
  getActive: (): Promise<ActiveCallsResponse> =>
    get<ActiveCallsResponse>('/v1/calls/active'),

  getCall: (id: string): Promise<CallLog> =>
    get<CallLog>(`/v1/calls/${id}`),

  list: (params?: {
    page?: number
    per_page?: number
    direction?: CallDirection
    status?: CallStatus
    contact_id?: string
    date_from?: string
    date_to?: string
    sort?: 'asc' | 'desc'
  }): Promise<CallsListResponse> =>
    get<CallsListResponse>('/v1/calls', params as Record<string, unknown>),

  getTranscript: (id: string): Promise<{ transcript: string; segments: TranscriptSegment[] }> =>
    get<{ transcript: string; segments: TranscriptSegment[] }>(`/v1/calls/${id}/transcript`),

  getSessionState: (correlationId: string): Promise<ActiveCall> =>
    get<ActiveCall>(`/v1/calls/session/${correlationId}`),

  endCall: (id: string): Promise<{ ended: boolean }> =>
    post<{ ended: boolean }>(`/v1/calls/${id}/end`),
}

export interface TranscriptSegment {
  speaker: 'ai' | 'contact'
  text: string
  timestamp_ms: number
  confidence?: number
}
