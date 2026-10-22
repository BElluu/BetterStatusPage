import { useEffect, useReducer } from 'react'
import type { MonitorStatus } from '@bsp/shared'
import { SNAPSHOT_URL } from '../dataSource'

interface StatusMap {
  [monitorId: number]: { status: MonitorStatus; responseMs: number | null; checkedAt: number }
}

type SseAction =
  | { type: 'monitor.status'; monitorId: number; status: MonitorStatus; responseMs: number | null; checkedAt: number }
  | { type: 'incident.created' | 'incident.updated'; payload: unknown }

function reducer(state: StatusMap, action: SseAction): StatusMap {
  if (action.type === 'monitor.status') {
    return {
      ...state,
      [action.monitorId]: {
        status: action.status,
        responseMs: action.responseMs,
        checkedAt: action.checkedAt,
      },
    }
  }
  return state
}

const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 60_000
/** While the stream is down the page refetches its data on this interval instead. */
const FALLBACK_REFRESH_MS = 30_000

export function useSSE(onIncidentChange?: () => void) {
  const [statusMap, dispatch] = useReducer(reducer, {})

  useEffect(() => {
    // A saved copy has no live stream; it rereads its snapshot instead.
    if (SNAPSHOT_URL) return
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let fallbackTimer: ReturnType<typeof setInterval> | null = null
    let retryMs = RETRY_MIN_MS
    let closed = false

    function connect() {
      if (closed) return
      es = new EventSource('/api/v1/public/events')

      es.addEventListener('monitor.status', (e) => {
        const data = JSON.parse(e.data) as { monitorId: number; status: MonitorStatus; responseMs: number | null; checkedAt: number }
        dispatch({ type: 'monitor.status', ...data })
      })

      es.addEventListener('incident.created', () => { onIncidentChange?.() })
      es.addEventListener('incident.updated', () => { onIncidentChange?.() })

      es.onopen = () => {
        retryMs = RETRY_MIN_MS
        if (fallbackTimer) clearInterval(fallbackTimer)
        fallbackTimer = null
      }

      // A refused stream (the server is at its limit) is retried with a growing, jittered delay,
      // and the page keeps itself current by polling in the meantime.
      es.onerror = () => {
        es?.close()
        es = null
        if (closed) return
        fallbackTimer ??= setInterval(() => { onIncidentChange?.() }, FALLBACK_REFRESH_MS)
        retryTimer = setTimeout(connect, retryMs * (0.5 + Math.random()))
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
      }
    }

    connect()

    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      if (fallbackTimer) clearInterval(fallbackTimer)
      es?.close()
    }
  }, [onIncidentChange])

  return statusMap
}
