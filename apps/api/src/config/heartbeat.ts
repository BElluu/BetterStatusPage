const DEFAULT_AUTO_CREATE_LIMIT = 50

/**
 * How many monitors one API token may create within an hour by sending a heartbeat to a key that does not exist yet.
 * `0` means no limit.
 */
export function getHeartbeatAutoCreateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['HEARTBEAT_AUTO_CREATE_LIMIT']?.trim()
  if (!raw) return DEFAULT_AUTO_CREATE_LIMIT
  if (!/^\d{1,9}$/.test(raw)) throw new Error('HEARTBEAT_AUTO_CREATE_LIMIT must be a non-negative integer')
  return Number(raw)
}
