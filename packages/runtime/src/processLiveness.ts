/** Wall-clock start of this process; identical in the main thread and in worker threads. */
export const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000)

/** Signal 0 checks existence only; EPERM still means the process exists under another user. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface ProcessOwner { pid: number; processStartedAt: number }

export function currentProcessOwner(): ProcessOwner {
  return { pid: process.pid, processStartedAt: PROCESS_STARTED_AT }
}

/**
 * Whether the recorded owner may still be running. The start time distinguishes a crashed
 * earlier incarnation that reused our pid (containers restart as the same pid) from us.
 */
export function isOwnerAlive(owner: Partial<ProcessOwner>): boolean {
  if (typeof owner.pid !== 'number') return false
  if (owner.pid === process.pid) {
    return typeof owner.processStartedAt === 'number' && Math.abs(owner.processStartedAt - PROCESS_STARTED_AT) < 1_000
  }
  return isProcessAlive(owner.pid)
}
