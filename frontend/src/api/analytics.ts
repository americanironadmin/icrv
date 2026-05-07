// src/api/analytics.ts — Phase 4 analytics endpoints
import { get } from './client'

export type Period = 7 | 30 | 90 | 'all'

export interface AnalyticsOverview {
  period: number | 'all'
  total_sent: number
  avg_open: number
  avg_click: number
  delivery: number
  total_bounced: number
  unsubscribed: number
}

export interface AnalyticsCampaign {
  id: string; name: string; status: string; created_at: string
  sent: number; opens: number; clicks: number; bounces: number
  open_rate: number; click_rate: number
}

export const analyticsApi = {
  overview:  (period: Period): Promise<AnalyticsOverview> => get('/v1/analytics/overview', { period: String(period) }),
  campaigns: (period: Period): Promise<{ campaigns: AnalyticsCampaign[] }> => get('/v1/analytics/campaigns', { period: String(period) }),
  opensByHour: (period: Period): Promise<{ buckets: Array<{ hour: number; opens: number }> }> => get('/v1/analytics/opens-by-hour', { period: String(period) }),
  emailStatus: (period: Period): Promise<{ statuses: Array<{ status: string; n: number }> }> => get('/v1/analytics/email-status', { period: String(period) }),
}
