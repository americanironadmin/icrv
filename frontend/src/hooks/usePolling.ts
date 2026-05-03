// src/hooks/usePolling.ts
// Generic polling hook — drives real-time updates for dashboard, call monitoring

import { useState, useEffect, useCallback, useRef } from 'react'

interface UsePollingOptions<T> {
  fetchFn: () => Promise<T>
  intervalMs?: number
  enabled?: boolean
  onError?: (err: unknown) => void
}

interface UsePollingResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  refresh: () => void
}

export function usePolling<T>({
  fetchFn,
  intervalMs = 10_000,
  enabled = true,
  onError,
}: UsePollingOptions<T>): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fetchFnRef = useRef(fetchFn)
  fetchFnRef.current = fetchFn

  const doFetch = useCallback(async () => {
    try {
      const result = await fetchFnRef.current()
      setData(result)
      setError(null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Request failed'
      setError(msg)
      onError?.(err)
    } finally {
      setLoading(false)
    }
  }, [onError])

  useEffect(() => {
    if (!enabled) return
    doFetch()
    const id = setInterval(doFetch, intervalMs)
    return () => clearInterval(id)
  }, [doFetch, intervalMs, enabled])

  return { data, loading, error, refresh: doFetch }
}
