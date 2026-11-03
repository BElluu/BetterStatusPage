import type { Monitor, MonitorListItem, MonitorStatus } from '@bsp/shared'
import { formatSpan } from '../../relativeTime'

/** Worst first: what needs a reaction sorts above what works. */
export const STATUS_SEVERITY: Record<MonitorStatus, number> = { down: 0, degraded: 1, affected: 2, pending: 3, up: 4 }

/** What the monitor looks at, as a line under its name: the URL or host, else the type. */
export function monitorEndpoint(monitor: Pick<Monitor, 'type' | 'config'>): string {
  return monitor.type === 'https'
    ? (monitor.config as { url: string }).url
    : monitor.type === 'ping'
    ? (monitor.config as { host: string }).host
    : monitor.type === 'dns'
    ? (monitor.config as { hostname: string }).hostname
    : `${monitor.type}`
}

/** A percentage with one decimal, without a trailing ".0": 100, 99.8, 94.1. */
export function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`
}

/** The slower-than-usual alert is open: the monitor still answers, but much slower than its own usual. */
export function isSlower(monitor: Pick<MonitorListItem, 'latencyAlertSince'>): boolean {
  return typeof monitor.latencyAlertSince === 'number'
}

/** How long a down or degraded monitor has been failing ("14 min"); undefined while it passes or the start is unknown. */
export function failingFor(monitor: Pick<MonitorListItem, 'currentStatus' | 'health'>, now: number): string | undefined {
  const since = monitor.health.failingSince
  return (monitor.currentStatus === 'down' || monitor.currentStatus === 'degraded') && since ? formatSpan(now - since) : undefined
}
