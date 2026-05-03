// src/api/dashboard.ts
// Real GET calls to icrv-api /v1/dashboard/* endpoints

import { get } from './client'

export interface DashboardStats {
  total_contacts: number
  active_campaigns: number
  emails_sent: number
  whatsapp_sent: number
  calls_made: number
  ai_actions_triggered: number
  updated_at: string
}

export interface ActivityItem {
  id: string
  type: 'email_sent' | 'whatsapp_sent' | 'call_made' | 'call_received' | 'ai_action' | 'contact_created'
  contact_id: string
  contact_name: string
  detail: string
  status: string
  occurred_at: string
}

export interface ApiStatus {
  service: 'gmail' | 'whatsapp' | 'ringcentral' | 'elevenlabs'
  connected: boolean
  last_checked: string
  error?: string
}

export interface DashboardActivity {
  items: ActivityItem[]
  total: number
}

export interface DashboardStatusResponse {
  services: ApiStatus[]
}

export const dashboardApi = {
  getStats: (): Promise<DashboardStats> =>
    get<DashboardStats>('/v1/dashboard/stats'),

  getActivity: (limit = 20): Promise<DashboardActivity> =>
    get<DashboardActivity>('/v1/dashboard/activity', { limit }),

  getServiceStatus: (): Promise<DashboardStatusResponse> =>
    get<DashboardStatusResponse>('/v1/dashboard/status'),
}
