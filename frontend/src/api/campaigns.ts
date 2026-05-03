// src/api/campaigns.ts
// Real calls to icrv-api /v1/campaigns endpoints

import { get, post, put, del } from './client'

export type CampaignChannel = 'email' | 'whatsapp' | 'voice'
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'

export interface CampaignStep {
  id?: string
  step_index: number
  channel: CampaignChannel
  template_id: string
  credential_id: string
  delay_hours: number
}

export interface Campaign {
  id: string
  tenant_id: string
  name: string
  description?: string
  channel: CampaignChannel
  status: CampaignStatus
  audience_filter?: Record<string, unknown>
  steps: CampaignStep[]
  enrolled_count: number
  sent_count: number
  opened_count: number
  clicked_count: number
  replied_count: number
  failed_count: number
  created_at: string
  updated_at: string
  launched_at?: string
  completed_at?: string
}

export interface CampaignCreatePayload {
  name: string
  description?: string
  channel: CampaignChannel
  audience_filter?: Record<string, unknown>
  steps: Omit<CampaignStep, 'id'>[]
}

export interface CampaignsListResponse {
  campaigns: Campaign[]
  total: number
  page: number
  per_page: number
}

export interface Template {
  id: string
  name: string
  channel: CampaignChannel
  subject?: string
  body_html?: string
  body_text?: string
  template_name?: string  // WA template name
  created_at: string
}

export const campaignsApi = {
  list: (params?: {
    page?: number
    per_page?: number
    status?: CampaignStatus
    channel?: CampaignChannel
  }): Promise<CampaignsListResponse> =>
    get<CampaignsListResponse>('/v1/campaigns', params as Record<string, unknown>),

  get: (id: string): Promise<Campaign> =>
    get<Campaign>(`/v1/campaigns/${id}`),

  create: (payload: CampaignCreatePayload): Promise<Campaign> =>
    post<Campaign>('/v1/campaigns', payload),

  update: (id: string, payload: Partial<CampaignCreatePayload>): Promise<Campaign> =>
    put<Campaign>(`/v1/campaigns/${id}`, payload),

  launch: (id: string): Promise<{ launched: boolean; enrolled: number }> =>
    post<{ launched: boolean; enrolled: number }>(`/v1/campaigns/${id}/launch`),

  pause: (id: string): Promise<Campaign> =>
    post<Campaign>(`/v1/campaigns/${id}/pause`),

  resume: (id: string): Promise<Campaign> =>
    post<Campaign>(`/v1/campaigns/${id}/resume`),

  cancel: (id: string): Promise<Campaign> =>
    post<Campaign>(`/v1/campaigns/${id}/cancel`),

  delete: (id: string): Promise<{ deleted: boolean }> =>
    del<{ deleted: boolean }>(`/v1/campaigns/${id}`),

  listTemplates: (channel?: CampaignChannel): Promise<{ templates: Template[] }> =>
    get<{ templates: Template[] }>('/v1/templates', channel ? { channel } : undefined),

  createTemplate: (t: Omit<Template, 'id' | 'created_at'>): Promise<Template> =>
    post<Template>('/v1/templates', t),
}
