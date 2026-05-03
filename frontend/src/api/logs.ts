// src/api/logs.ts
// Real calls to icrv-api /v1/logs endpoints

import { get } from './client'

export type LogEventType =
  | 'email_sent'
  | 'email_opened'
  | 'email_clicked'
  | 'email_bounced'
  | 'whatsapp_sent'
  | 'whatsapp_delivered'
  | 'whatsapp_read'
  | 'whatsapp_replied'
  | 'call_initiated'
  | 'call_connected'
  | 'call_ended'
  | 'call_voicemail'
  | 'ai_action'
  | 'ai_run_started'
  | 'ai_run_completed'
  | 'contact_created'
  | 'contact_updated'
  | 'campaign_launched'
  | 'unsubscribe'

export interface LogEntry {
  id: string
  tenant_id: string
  event_type: LogEventType
  contact_id?: string
  contact_name?: string
  contact_email?: string
  campaign_id?: string
  campaign_name?: string
  message_id?: string
  call_log_id?: string
  agent_run_id?: string
  status: string
  payload?: Record<string, unknown>
  response?: Record<string, unknown>
  occurred_at: string
}

export interface LogsResponse {
  logs: LogEntry[]
  total: number
  page: number
  per_page: number
}

export const logsApi = {
  list: (params?: {
    page?: number
    per_page?: number
    event_type?: LogEventType
    contact_id?: string
    campaign_id?: string
    date_from?: string
    date_to?: string
    sort?: 'asc' | 'desc'
  }): Promise<LogsResponse> =>
    get<LogsResponse>('/v1/logs', params as Record<string, unknown>),

  getEntry: (id: string): Promise<LogEntry> =>
    get<LogEntry>(`/v1/logs/${id}`),
}
