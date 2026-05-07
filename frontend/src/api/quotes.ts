// src/api/quotes.ts — v2.7 quotes module API client
import { get, post, put, del } from './client'

export interface QuoteLineItem {
  description: string
  qty:         number
  unit_cents:  number
  total_cents: number
}

export interface Quote {
  id:             string
  contact_id:     string
  quote_number:   string
  status:         'draft' | 'sent' | 'accepted' | 'declined' | 'expired'
  currency:       string
  subtotal_cents: number
  tax_cents:      number
  total_cents:    number
  line_items:     QuoteLineItem[]
  notes:          string
  channel:        'whatsapp' | 'email' | 'manual'
  wa_message_id:  string | null
  created_at:     string
  sent_at:        string | null
  accepted_at:    string | null
  expires_at:     string | null
  contact?: {
    id: string; name: string | null; email: string | null; phone: string | null
  }
}

export interface QuoteCreate {
  contact_id: string
  line_items: QuoteLineItem[]
  notes?:     string
  currency?:  string
  tax_cents?: number
  expires_at?: string
}

export const quotesApi = {
  list: (params?: { status?: string; contact_id?: string }): Promise<{ quotes: Quote[] }> =>
    get<{ quotes: Quote[] }>('/v1/quotes', params as Record<string, unknown>),
  get: (id: string): Promise<Quote> => get<Quote>(`/v1/quotes/${id}`),
  create: (q: QuoteCreate): Promise<Quote> => post<Quote>('/v1/quotes', q as unknown as Record<string, unknown>),
  update: (id: string, patch: Partial<QuoteCreate>): Promise<Quote> =>
    put<Quote>(`/v1/quotes/${id}`, patch as Record<string, unknown>),
  send: (id: string): Promise<Quote> => post<Quote>(`/v1/quotes/${id}/send`),
  setStatus: (id: string, status: 'accepted'|'declined'|'expired'): Promise<Quote> =>
    post<Quote>(`/v1/quotes/${id}/status`, { status }),
  delete: (id: string): Promise<{ deleted: boolean }> => del<{ deleted: boolean }>(`/v1/quotes/${id}`),
}
