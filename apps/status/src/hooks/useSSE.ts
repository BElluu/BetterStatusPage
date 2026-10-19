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

export function useSSE(onIncidentChange?: () => void) {
  const [statusMap, dispatch] = useReducer(reducer, {})

  useEffect(() => {
    // A saved copy has no live stream; it rereads its snapshot instead.
    if (SNAPSHOT_URL) return
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
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

      es.onerror = () => {
        es?.close()
        es = null
        if (!closed) {
          retryTimer = setTimeout(connect, 2000)
        }
      }
    }

    connect()

    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      es?.close()
    }
  }, [onIncidentChange])

  return statusMap
}
