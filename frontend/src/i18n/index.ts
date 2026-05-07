// src/i18n/index.ts
// Minimal i18n helper. Single global locale; toggle via setLocale, observe via
// the Custom Event 'icrv:locale-changed' (re-renders consumers cheaply).

import en from './en.json'
import ar from './ar.json'

export type Locale = 'en' | 'ar'

const dictionaries: Record<Locale, Record<string, string>> = { en, ar }

let current: Locale = (localStorage.getItem('icrv_locale') as Locale | null) ?? 'en'

export function getLocale(): Locale {
  return current
}

export function isRtl(loc?: Locale): boolean {
  return (loc ?? current) === 'ar'
}

export function setLocale(loc: Locale): void {
  current = loc
  localStorage.setItem('icrv_locale', loc)
  document.documentElement.setAttribute('dir', isRtl(loc) ? 'rtl' : 'ltr')
  document.documentElement.setAttribute('lang', loc)
  window.dispatchEvent(new CustomEvent('icrv:locale-changed', { detail: { locale: loc } }))
}

export function t(key: string, fallback?: string): string {
  return dictionaries[current][key] ?? fallback ?? key
}

// Initial dir/lang sync so SSR-equivalent behaviour during boot.
document.documentElement.setAttribute('dir', isRtl() ? 'rtl' : 'ltr')
document.documentElement.setAttribute('lang', current)
