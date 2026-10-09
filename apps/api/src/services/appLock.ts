import fs from 'fs'
import path from 'path'
import { dataDir } from '../config.js'
import { currentProcessOwner, isOwnerAlive, type ProcessOwner } from './processLiveness.js'

const FRESH_MS = 30_000
/**
 * A stalled heartbeat (event loop blocked by a long synchronous task) still counts as running
 * while the recorded pid is alive — but only for this long, so a reused pid cannot block forever.
 */
const LIVE_OWNER_MS = 10 * 60_000
const RUNNING_MESSAGE = 'BetterStatusPage is still running. Stop the application before restoring.'
function lockPath(): string { return path.join(dataDir(), '.bsp-running') }

function readOwner(file: string): Partial<ProcessOwner> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProcessOwner> }
  catch { return {} }
}

/** Removes a marker whose owner is gone; throws while the app still looks alive. */
function clearStaleMarker(options: { checkOwner: boolean }): void {
  const file = lockPath()
  if (!fs.existsSync(file)) return
  const age = Date.now() - fs.statSync(file).mtimeMs
  const ownerAlive = isOwnerAlive(readOwner(file))
  // A killed process (Ctrl+C on Windows, tsx watch restart) leaves a fresh marker; startup trusts a dead pid over the heartbeat.
  if (age < FRESH_MS && (options.checkOwner || ownerAlive)) throw new Error(RUNNING_MESSAGE)
  if (options.checkOwner && age < LIVE_OWNER_MS && ownerAlive) throw new Error(RUNNING_MESSAGE)
  fs.rmSync(file, { force: true })
}

/** Used by restore: also refuses while the recorded app process is alive but its heartbeat has stalled. */
export function assertAppStopped(): void {
  clearStaleMarker({ checkOwner: true })
}

/** Startup uses the heartbeat only, so a restart after a crash is never blocked by an unrelated process that reused the pid. */
export function acquireAppLock(): () => void {
  clearStaleMarker({ checkOwner: false })
  fs.mkdirSync(dataDir(), { recursive: true })
  const file = lockPath()
  fs.writeFileSync(file, JSON.stringify({ ...currentProcessOwner(), startedAt: Date.now() }), { flag: 'wx', mode: 0o600 })
  const heartbeat = setInterval(() => {
    try { fs.utimesSync(file, new Date(), new Date()) } catch { /* shutdown race */ }
  }, 5_000)
  heartbeat.unref()
  let released = false
  return () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    fs.rmSync(file, { force: true })
  }
}
