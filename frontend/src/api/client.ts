// src/api/client.ts
// Base Axios client wired to the icrv-api Cloudflare Worker.
// Auth token is sourced from Cloudflare Access (CF_Authorization cookie, injected
// automatically) plus an explicit Bearer token for programmatic calls.

import axios, { type AxiosInstance, type AxiosResponse } from 'axios'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://api.icrv.app'

// ─── Create axios instance ────────────────────────────────────────────────────

const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  withCredentials: true, // sends CF_Authorization cookie automatically
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
})

// ─── Request interceptor — attach stored JWT if present ──────────────────────

api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('icrv_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// ─── Response interceptor — global error normalisation ───────────────────────
//
// On 401 we clear local credentials so the AuthGate in App.tsx renders the
// sign-in screen. We do NOT force a navigation here — that produced an
// infinite redirect loop on first load when no token had ever been stored.
// React state changes are enough to flip the UI to the sign-in view.

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      sessionStorage.removeItem('icrv_token')
      sessionStorage.removeItem('icrv_user')
      // Notify the app shell so it can re-render the sign-in gate without
      // a full-page navigation. AuthGate listens for this event.
      window.dispatchEvent(new CustomEvent('icrv:unauthorized'))
    }
    return Promise.reject(error)
  },
)

export default api

// ─── Generic helpers ─────────────────────────────────────────────────────────

export async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res: AxiosResponse<T> = await api.get(path, { params })
  return res.data
}

export async function post<T>(path: string, data?: unknown): Promise<T> {
  const res: AxiosResponse<T> = await api.post(path, data)
  return res.data
}

export async function put<T>(path: string, data?: unknown): Promise<T> {
  const res: AxiosResponse<T> = await api.put(path, data)
  return res.data
}

export async function del<T>(path: string): Promise<T> {
  const res: AxiosResponse<T> = await api.delete(path)
  return res.data
}

export async function postForm<T>(path: string, formData: FormData): Promise<T> {
  const res: AxiosResponse<T> = await api.post(path, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}
