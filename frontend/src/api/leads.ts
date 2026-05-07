// src/api/leads.ts — Phase 4 lead intelligence endpoints
import { get, post } from './client'

export interface LeadIntelligence {
  counts: { hot: number; warm: number; cold: number; total: number }
  top_hot:  Array<{ contact_id: string; score: number; name: string; email: string | null; country_code: string | null; industry: string | null }>
  top_warm: Array<{ contact_id: string; score: number; name: string; email: string | null; country_code: string | null; industry: string | null }>
  weights:  { engagement: number; demographics: number; behavioral: number; tags: number }
}

export interface RankedLead {
  contact_id: string
  name: string
  email: string | null
  country: string | null
  industry: string | null
  score: number
  category: 'hot' | 'warm' | 'cold'
  engagement: number
  demographic: number
  behavioral: number
  tag: number
  tags: string[]
  last_calculated: string
}

export interface RankedLeadsResponse {
  total: number; page: number; per_page: number
  leads: RankedLead[]
}

export const leadsApi = {
  intelligence: (): Promise<LeadIntelligence> => get('/v1/leads/intelligence'),
  ranked: (params?: { page?: number; per_page?: number; category?: 'hot' | 'warm' | 'cold' | 'all' }): Promise<RankedLeadsResponse> => {
    const query: Record<string, unknown> = { ...(params ?? {}) }
    if (query.category === 'all') delete query.category
    return get('/v1/leads/ranked', query)
  },
  recalculateAll: (): Promise<{ ok: true; updated: number }> => post('/v1/leads/recalculate-all'),
}
