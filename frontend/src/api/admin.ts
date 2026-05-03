// src/api/admin.ts
// Settings page admin endpoints — list integrations, save WhatsApp creds,
// configure ElevenLabs agent + phone number id.

import { get, post, put } from './client'

export interface IntegrationsState {
  gmail: { connected: boolean; email: string | null; oauth_token_id: string | null }
  whatsapp: {
    connected: boolean
    credential_id: string | null
    label: string | null
    metadata: { phone_number_id?: string; business_id?: string }
  }
  ringcentral: {
    connected: boolean
    credential_id: string | null
    label: string | null
    metadata: { from_phone_e164?: string; el_trunk_phone_e164?: string }
  }
  elevenlabs: {
    connected: boolean
    credential_id: string | null
    label: string | null
    agent_id: string | null
    metadata: { phone_number_id?: string }
  }
}

export interface WhatsAppPayload {
  phone_number_id: string
  business_id?: string
  access_token: string
}

export interface ElevenLabsPayload {
  agent_id?: string
  phone_number_id?: string
}

export const adminApi = {
  getIntegrations: () => get<IntegrationsState>('/v1/admin/integrations'),
  saveWhatsApp:    (p: WhatsAppPayload) => post<{ ok: true; credential_id: string; phone_number_id: string }>('/v1/admin/integrations/whatsapp', p),
  saveElevenLabs:  (p: ElevenLabsPayload) => put<{ ok: true; agent_id?: string; phone_number_id?: string; credential_id?: string }>('/v1/admin/integrations/elevenlabs', p),
}
