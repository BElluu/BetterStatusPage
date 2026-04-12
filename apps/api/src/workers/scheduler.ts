import cron from 'node-cron'
import { db } from '../db/client.js'
import { monitors, monitorResults, maintenanceWindows, maintenanceWindowMonitors, monitorDependencies } from '../db/schema.js'
import { sseService } from '../services/sse.service.js'
import { checkHttps } from './https.js'
import { checkPing } from './ping.js'
import { checkDns } from './dns.js'
import { checkSqlServer } from './sqlserver.js'
import { sendNotifications } from './notifier.js'
import { lt, eq, and, lte, gte, inArray } from 'drizzle-orm'
import type { HttpsConfig, PingConfig, DnsConfig, SqlServerConfig, MonitorStatus } from '@bsp/shared'

async function isInMaintenance(monitorId: number): Promise<boolean> {
  const now = Date.now()
  const activeWindows = await db.select().from(maintenanceWindows).where(
    and(lte(maintenanceWindows.startsAt, now), gte(maintenanceWindows.endsAt, now)),
  )
  if (activeWindows.length === 0) return false
  for (const win of activeWindows) {
    const links = await db.select().from(maintenanceWindowMonitors).where(eq(maintenanceWindowMonitors.windowId, win.id))
    // Empty link list means all monitors are in maintenance
    if (links.length === 0) return true
    if (links.some((l) => l.monitorId === monitorId)) return true
  }
  return false
}

const CONCURRENCY = 20

export async function runCheck(monitor: typeof monitors.$inferSelect) {
  const config = JSON.parse(monitor.config) as HttpsConfig | PingConfig | DnsConfig | SqlServerConfig
  let result: { status: MonitorStatus; responseMs: number | null; error: string | null }

  const maxAttempts = (monitor.retries ?? 1)
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      switch (monitor.type) {
        case 'https': result = await checkHttps(config as HttpsConfig, monitor.timeoutMs); break
        case 'ping': result = await checkPing(config as PingConfig, monitor.timeoutMs); break
        case 'dns': result = await checkDns(config as DnsConfig, monitor.timeoutMs); break
        case 'sqlserver': result = await checkSqlServer(config as SqlServerConfig, monitor.timeoutMs); break
        case 'webhook': result = { status: 'down', responseMs: null, error: 'No webhook received within interval' }; break
        default: result = { status: 'down', responseMs: null, error: `Unknown type: ${monitor.type}` }
      }
      if (result.status !== 'down' || attempt === maxAttempts) break
    }
  } catch (err) {
    result = { status: 'down', responseMs: null, error: err instanceof Error ? err.message : String(err) }
  }

  // If any declared dependency is down/degraded/affected, mark this monitor as 'affected'
  // regardless of its own check result — the root-cause monitor fires the alert.
  const deps = await db.select().from(monitorDependencies).where(eq(monitorDependencies.dependentId, monitor.id))
  if (deps.length > 0) {
    const depIds = deps.map((d) => d.dependsOnId)
    const depMonitors = await db.select().from(monitors).where(inArray(monitors.id, depIds))
    const hasDownDep = depMonitors.some((d) =>
      d.currentStatus === 'down' || d.currentStatus === 'degraded' || d.currentStatus === 'affected',
    )
    if (hasDownDep) result = { ...result, status: 'affected' }
  }

  const checkedAt = Date.now()

  await db.insert(monitorResults).values({
    monitorId: monitor.id,
    status: result.status,
    responseMs: result.responseMs,
    checkedAt,
    errorMessage: result.error,
  })

  const prevStatus = monitor.currentStatus
  await db.update(monitors).set({ currentStatus: result.status, lastCheckedAt: checkedAt, updatedAt: checkedAt }).where(eq(monitors.id, monitor.id))

  // Always broadcast so the admin UI can update lastCheckedAt and status in real-time.
  sseService.broadcast('monitor.status', { monitorId: monitor.id, status: result.status, responseMs: result.responseMs, checkedAt })

  if (prevStatus !== result.status) {
    isInMaintenance(monitor.id).then((inMaintenance) => {
      if (inMaintenance) return
      sendNotifications(monitor, result.status, prevStatus, result.error).catch((err) =>
        console.error('[notifier] sendNotifications failed:', err),
      )
    }).catch((err) => console.error('[scheduler] isInMaintenance check failed:', err))
  }
}

async function tick() {
  const now = Date.now()
  const allMonitors = await db.select().from(monitors)
  const due = allMonitors.filter((m) => !m.lastCheckedAt || m.lastCheckedAt + m.intervalSecs * 1000 <= now)
  if (due.length === 0) return

  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const chunk = due.slice(i, i + CONCURRENCY)
    await Promise.allSettled(chunk.map(runCheck))
  }
}

async function purgeOldResults() {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  await db.delete(monitorResults).where(lt(monitorResults.checkedAt, cutoff))
  console.log('[scheduler] Purged old monitor results')
}

export function startScheduler() {
  cron.schedule('*/10 * * * * *', () => {
    tick().catch((err) => console.error('[scheduler] tick error:', err))
  })
  cron.schedule('0 2 * * *', () => {
    purgeOldResults().catch(console.error)
  })
  console.log('[scheduler] Started')
}
