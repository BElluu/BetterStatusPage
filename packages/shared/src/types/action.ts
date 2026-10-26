import type { VaultRef } from '@better-kit/contracts'

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
  /** Vault secrets the request reads, each under a name of its own: see {@link ActionSecret}. */
  secrets?: ActionSecret[]
}

/**
 * A vault secret an action reads, used through placeholders in the URL, a header value or the body. A Secure Value is
 * `{{secret_<name>}}`; a User / Password secret is `{{secret_<name>_username}}`, `{{secret_<name>_password}}` and
 * `{{secret_<name>_basic}}` (the Base64 of `user:password`, for Basic authentication); a JSON secret gives
 * `{{secret_<name>_<key>}}` for each key. The `name` is letters and digits.
 */
export interface ActionSecret {
  name: string
  vault: VaultRef
}

export interface Action {
  id: number
  /** Stable identifier for configuration files and API clients; set when the action is created and never changed. */
  key: string
  name: string
  config: ActionHttpConfig
  enabled: number
  /** 1: a run waits for an admin to approve it in the panel before it is sent. */
  requiresApproval: number
  /** How long a run waits for that approval before it is cancelled. */
  approvalTimeoutMinutes: number
  /** Notification channels told when a run of this action fails after its last attempt, and when one succeeds if the channel is set to. */
  notificationChannelIds: number[]
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

export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 60

/**
 * `awaiting_approval`: waiting for an admin to approve or reject it; `nextAttemptAt` is when it expires.
 * `cancelled`: the monitor left `onStatus` before the run was due, or the run was rejected or expired.
 */
export type ActionRunStatus = 'pending' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled'

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
