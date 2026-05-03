// src/api/client.ts
// Base Axios client wired to the icrv-api Cloudflare Worker.
//
// PR 6: auth is sourced exclusively from the Cloudflare Access cookie
// (CF_Authorization), sent automatically thanks to withCredentials. No more
// Bearer interceptor, no more sessionStorage tokens. On 401 we just dispatch
// 'icrv:unauthorized' so the AuthGate flips back to the sign-in panel.

import axios, { type AxiosInstance, type AxiosResponse } from 'axios'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://api.icrv.app'

const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  withCredentials: true, // sends CF_Authorization cookie automatically
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
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
