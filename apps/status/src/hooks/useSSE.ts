import { useEffect, useReducer } from 'react'
import type { MonitorStatus } from '@bsp/shared'

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
    const es = new EventSource('/api/v1/public/events')

    es.addEventListener('monitor.status', (e) => {
      const data = JSON.parse(e.data) as { monitorId: number; status: MonitorStatus; responseMs: number | null; checkedAt: number }
      dispatch({ type: 'monitor.status', ...data })
    })

    es.addEventListener('incident.created', () => {
      onIncidentChange?.()
    })

    es.addEventListener('incident.updated', () => {
      onIncidentChange?.()
    })

    return () => es.close()
  }, [onIncidentChange])

  return statusMap
}
