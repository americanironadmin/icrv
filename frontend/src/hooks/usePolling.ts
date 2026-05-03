// src/hooks/usePolling.ts
// Generic polling hook — drives real-time updates for dashboard, call monitoring.
//
// Visibility-aware (PR 5 / H4): when the tab is hidden, the interval is cleared
// to avoid burning Workers requests on a tab nobody is watching. On focus we
// fire one immediate fetch and re-arm the interval.

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

    let intervalId: ReturnType<typeof setInterval> | null = null

    const arm = () => {
      if (intervalId !== null) return
      intervalId = setInterval(doFetch, intervalMs)
    }
    const disarm = () => {
      if (intervalId === null) return
      clearInterval(intervalId)
      intervalId = null
    }

    const onVisibility = () => {
      if (document.hidden) {
        disarm()
      } else {
        // Re-armed: catch up immediately, then resume the cadence.
        doFetch()
        arm()
      }
    }

    // Initial: only fetch + arm if the tab is currently visible.
    doFetch()
    if (!document.hidden) arm()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      disarm()
    }
  }, [doFetch, intervalMs, enabled])

  return { data, loading, error, refresh: doFetch }
}
