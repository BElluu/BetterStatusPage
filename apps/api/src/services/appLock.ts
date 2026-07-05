import fs from 'fs'
import path from 'path'
import { dataDir } from '../config.js'

const FRESH_MS = 30_000
function lockPath(): string { return path.join(dataDir(), '.bsp-running') }

export function assertAppStopped(): void {
  const file = lockPath()
  if (!fs.existsSync(file)) return
  if (Date.now() - fs.statSync(file).mtimeMs < FRESH_MS) {
    throw new Error('BetterStatusPage is still running. Stop the application before restoring.')
  }
  fs.rmSync(file, { force: true })
}

export function acquireAppLock(): () => void {
  assertAppStopped()
  fs.mkdirSync(dataDir(), { recursive: true })
  const file = lockPath()
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 })
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
