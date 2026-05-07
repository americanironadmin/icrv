// src/api/contacts.ts
// Real CRUD calls to icrv-api /v1/contacts endpoints

import { get, post, put, del, postForm } from './client'

export interface Contact {
  id: string
  tenant_id: string
  name: string
  email?: string
  phone?: string
  whatsapp_phone?: string
  consent_email: boolean
  consent_whatsapp: boolean
  consent_voice: boolean
  tags: string[]
  created_at: string
  updated_at: string
}

export interface ContactCreatePayload {
  name: string
  email?: string
  phone?: string
  whatsapp_phone?: string
  consent_email?: boolean
  consent_whatsapp?: boolean
  consent_voice?: boolean
  tags?: string[]
}

export interface ContactUpdatePayload extends Partial<ContactCreatePayload> {}

export interface ContactsListResponse {
  contacts: Contact[]
  total: number
  page: number
  per_page: number
}

export interface BulkUploadResponse {
  job_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  total_rows?: number
  accepted?: number
  rejected?: number
  errors?: { row: number; reason: string }[]
  r2_key?: string
}

export interface UploadJobStatus {
  job_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  total_rows: number
  processed: number
  accepted: number
  rejected: number
  errors: { row: number; reason: string }[]
  completed_at?: string
  created_at?: string
  updated_at?: string
}

export const contactsApi = {
  list: (params?: {
    page?: number
    per_page?: number
    search?: string
    consent_filter?: string
    tag?: string
  }): Promise<ContactsListResponse> =>
    get<ContactsListResponse>('/v1/contacts', params as Record<string, unknown>),

  get: (id: string): Promise<Contact> =>
    get<Contact>(`/v1/contacts/${id}`),

  create: (payload: ContactCreatePayload): Promise<Contact> =>
    post<Contact>('/v1/contacts', payload),

  update: (id: string, payload: ContactUpdatePayload): Promise<Contact> =>
    put<Contact>(`/v1/contacts/${id}`, payload),

  delete: (id: string): Promise<{ deleted: boolean }> =>
    del<{ deleted: boolean }>(`/v1/contacts/${id}`),

  bulkUpload: (csv: File): Promise<BulkUploadResponse> => {
    const form = new FormData()
    form.append('file', csv)
    return postForm<BulkUploadResponse>('/v1/contacts/bulk-upload', form)
  },

  getUploadJob: (jobId: string): Promise<UploadJobStatus> =>
    get<UploadJobStatus>(`/v1/contacts/bulk-upload/${jobId}`),

  // ── v2.6 bulk actions ────────────────────────────────────────────────
  bulk: (body: BulkActionPayload): Promise<{ affected: number }> =>
    post<{ affected: number }>('/v1/contacts/bulk', body as unknown as Record<string, unknown>),

  consentRequest: (body: { filter: BulkFilter; only_pending?: boolean }):
    Promise<{ requested: number; skipped_no_email: number; total_matched: number }> =>
    post('/v1/contacts/consent-request', body as unknown as Record<string, unknown>),

  consentSummary: (channel: 'email' | 'whatsapp' | 'voice' = 'email'):
    Promise<{ channel: string; total: number; granted: number; revoked: number; pending: number; never_requested: number }> =>
    get('/v1/contacts/consent-summary', { channel }),
}

// ── Bulk action payloads (matches workers/icrv-api/src/routes/contacts-bulk.ts) ──

export interface BulkFilter {
  all?:           boolean
  ids?:           string[]
  search?:        string
  tag?:           string
  country?:       string
  industry?:      string
  has_email?:     boolean
  consent_state?: 'granted' | 'revoked' | 'pending' | 'none' | 'never_requested'
  consent_channel?: 'email' | 'whatsapp' | 'voice'
}

export type BulkAction =
  | { filter: BulkFilter; action: 'delete' }
  | { filter: BulkFilter; action: 'add_tag';     params: { tag: string } }
  | { filter: BulkFilter; action: 'remove_tag';  params: { tag: string } }
  | { filter: BulkFilter; action: 'set_tags';    params: { tags: string[] } }
  | { filter: BulkFilter; action: 'set_field';   params: { field: 'country_code' | 'country_name_ar' | 'industry' | 'industry_ar' | 'region_tier'; value: string | null } }
  | { filter: BulkFilter; action: 'set_consent'; params: { channel: 'email' | 'whatsapp' | 'voice'; state: 'granted' | 'revoked' } }

export type BulkActionPayload = BulkAction
