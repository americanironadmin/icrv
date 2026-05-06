// src/api/settings.ts
// Settings sections — each round-trips a JSON object.

import { get, put } from './client'

export type SettingsSection =
  | 'workspace'
  | 'compliance'
  | 'sending'
  | 'tracking'
  | 'authentication'
  | 'personalization'
  | 'bounce'
  | 'api_webhooks'

export interface WorkspaceSettings {
  company_name: string
  website: string
  timezone: string
  logo_url?: string
}

export interface ComplianceSettings {
  physical_address: {
    street: string
    city: string
    state: string
    zip: string
    country: string
  }
  unsubscribe_text: string
}

export interface SendingSettings {
  daily_limit: number
  throttle_per_sec: number
  warmup_enabled: boolean
  custom_from_domain: string
}

export interface TrackingSettings {
  open_tracking: boolean
  click_tracking: boolean
  custom_domain: string
  utm_prefix: string
  utm_medium: string
  utm_campaign_prefix: string
  google_analytics: boolean
}

export interface AuthenticationSettings {
  domain: string
  dkim_selector: string
  dkim_public_key: string
}

export interface BounceSettings {
  hard_bounce_threshold: number
  soft_bounce_retries: number
  autounsub_on_complaint: boolean
  bounce_notification_email: string
}

export type SectionPayload =
  | WorkspaceSettings
  | ComplianceSettings
  | SendingSettings
  | TrackingSettings
  | AuthenticationSettings
  | BounceSettings
  | Record<string, unknown>

export const settingsApi = {
  getAll: (): Promise<Record<SettingsSection, Record<string, unknown>>> =>
    get('/v1/settings'),

  getSection: <T = Record<string, unknown>>(section: SettingsSection): Promise<T> =>
    get<T>(`/v1/settings/${section}`),

  saveSection: <T = Record<string, unknown>>(section: SettingsSection, payload: SectionPayload): Promise<T> =>
    put<T>(`/v1/settings/${section}`, payload as unknown as Record<string, unknown>),
}
