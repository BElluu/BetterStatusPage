import type { MonitorStatus } from '@bsp/shared'

/** Statuses that represent a failing monitor and therefore open an alert. */
const FAILURE_STATUSES = new Set<string>(['down', 'degraded'])

export interface AlertThresholdState {
  alertConfirmedStatus: string
  alertPendingStatus: string | null
  alertPendingCount: number
  failureThreshold: number
  recoveryThreshold: number
}

export interface AlertTransition {
  alertConfirmedStatus: string
  alertPendingStatus: string | null
  alertPendingCount: number
  /** Non-null when the observation confirmed a new state that should be notified. */
  fire: { status: MonitorStatus; previousStatus: string } | null
}

/**
 * Consecutive observations of `observed` needed to leave `confirmed`.
 * Only the healthy→failing and failing→up edges are debounced; every other edge
 * (degraded↔down, anything↔affected, the first check after 'pending') stays immediate,
 * which is exactly what the notifier did before thresholds existed.
 */
function thresholdFor(confirmed: string, observed: string, state: AlertThresholdState): number {
  if (FAILURE_STATUSES.has(observed) && !FAILURE_STATUSES.has(confirmed)) return Math.max(1, state.failureThreshold)
  if (observed === 'up' && FAILURE_STATUSES.has(confirmed)) return Math.max(1, state.recoveryThreshold)
  return 1
}

/**
 * Folds one check result into a monitor's alert state. A status becomes "confirmed" — and only
 * then fires a notification — after being observed `threshold` times in a row; a single contrary
 * observation resets the streak, so a flapping endpoint never alerts. With both thresholds at 1
 * (the default) this reduces to "notify on every status change".
 */
export function evaluateAlertTransition(state: AlertThresholdState, observed: MonitorStatus): AlertTransition {
  const confirmed = state.alertConfirmedStatus
  if (observed === confirmed) {
    return { alertConfirmedStatus: confirmed, alertPendingStatus: null, alertPendingCount: 0, fire: null }
  }

  const threshold = thresholdFor(confirmed, observed, state)
  const count = state.alertPendingStatus === observed ? state.alertPendingCount + 1 : 1

  if (count >= threshold) {
    return {
      alertConfirmedStatus: observed,
      alertPendingStatus: null,
      alertPendingCount: 0,
      fire: { status: observed, previousStatus: confirmed },
    }
  }
  return { alertConfirmedStatus: confirmed, alertPendingStatus: observed, alertPendingCount: count, fire: null }
}
