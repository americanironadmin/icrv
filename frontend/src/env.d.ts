/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_APP_NAME: string
  readonly VITE_CF_ACCESS_TEAM?: string         // legacy — VITE_CF_ACCESS_TEAM_DOMAIN preferred
  readonly VITE_CF_ACCESS_TEAM_DOMAIN?: string  // PR 6 — full team domain (acme.cloudflareaccess.com)
  readonly VITE_CF_ACCESS_AUD?: string          // PR 6 — application AUD tag
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_BUILD_SHA?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
