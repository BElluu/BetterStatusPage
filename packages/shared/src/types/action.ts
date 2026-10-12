/** An action changes something outside BetterStatusPage when a monitor goes down or comes back up. */

/** The confirmed monitor status an action waits for. */
export type ActionTriggerStatus = 'down' | 'up'
export const ACTION_TRIGGER_STATUSES: readonly ActionTriggerStatus[] = ['down', 'up']

/** An HTTP request. `url`, header values and `body` accept the same `{{variables}}` as a webhook channel. */
export interface ActionHttpConfig {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  headers?: Record<string, string>
  body?: string
}

export interface Action {
  id: number
  name: string
  config: ActionHttpConfig
  enabled: number
  createdAt: number
  updatedAt: number
}

/** Runs an action for a monitor once it has been in `onStatus` for `delayMinutes`, at most once per `cooldownMinutes`. */
export interface MonitorAction {
  actionId: number
  onStatus: ActionTriggerStatus
  delayMinutes: number
  cooldownMinutes: number
}

/** `cancelled`: the monitor left `onStatus` before the run was due. */
export type ActionRunStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export interface ActionRun {
  id: number
  actionId: number
  actionName: string
  monitorId: number | null
  monitorName: string
  onStatus: ActionTriggerStatus
  status: ActionRunStatus
  attemptCount: number
  maxAttempts: number
  nextAttemptAt: number | null
  lastAttemptAt: number | null
  completedAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}
