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
  total_rows: number
  accepted: number
  rejected: number
  errors: { row: number; reason: string }[]
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
}
