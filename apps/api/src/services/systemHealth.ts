import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { monitors, notificationDeliveries } from '../db/schema.js'
import { resolveAppVersion } from '../version.js'
import { listBackups, readBackupConfig, readBackupStatus } from './backup.js'
import { getSchedulerHealth } from '../workers/scheduler.js'

type ComponentStatus = 'ok' | 'attention' | 'error' | 'disabled'

export interface SystemHealthReport {
  status: 'healthy' | 'degraded'
  generatedAt: number
  application: {
    status: 'ok'
    version: string
    uptimeSeconds: number
  }
  database: {
    status: 'ok' | 'error'
    responseMs: number | null
  }
  monitoring: {
    status: ComponentStatus
    schedulerRunning: boolean
    configuredMonitors: number | null
    overdueMonitors: number | null
    lastMonitorCheckAt: number | null
    lastTickStartedAt: number | null
    lastTickCompletedAt: number | null
    lastTickDurationMs: number | null
    lastTickDueMonitors: number
    lastTickFailedChecks: number
  }
  notifications: {
    status: ComponentStatus
    pending: number | null
    failed: number | null
    lastDeliveredAt: number | null
  }
  backups: {
    status: ComponentStatus
    scheduleEnabled: boolean
    state: 'idle' | 'running' | 'success' | 'error'
    storedBackups: number | null
    latestBackupAt: number | null
    lastCompletedAt: number | null
  }
}

export async function getSystemHealthReport(now = Date.now()): Promise<SystemHealthReport> {
  const scheduler = getSchedulerHealth()
  const databaseStartedAt = Date.now()
  let database: SystemHealthReport['database'] = { status: 'error', responseMs: null }
  let monitoringData: Pick<SystemHealthReport['monitoring'], 'configuredMonitors' | 'overdueMonitors' | 'lastMonitorCheckAt'> = {
    configuredMonitors: null,
    overdueMonitors: null,
    lastMonitorCheckAt: null,
  }
  let notifications: SystemHealthReport['notifications'] = {
    status: 'error', pending: null, failed: null, lastDeliveredAt: null,
  }

  try {
    await db.run(sql`SELECT 1`)
    database = { status: 'ok', responseMs: Date.now() - databaseStartedAt }

    const monitorRows = await db.select({
      intervalSecs: monitors.intervalSecs,
      lastCheckedAt: monitors.lastCheckedAt,
    }).from(monitors)
    monitoringData = {
      configuredMonitors: monitorRows.length,
      overdueMonitors: monitorRows.filter((monitor) =>
        monitor.lastCheckedAt === null || monitor.lastCheckedAt + monitor.intervalSecs * 2_000 < now,
      ).length,
      lastMonitorCheckAt: monitorRows.reduce<number | null>((latest, monitor) =>
        monitor.lastCheckedAt !== null && (latest === null || monitor.lastCheckedAt > latest) ? monitor.lastCheckedAt : latest,
      null),
    }

    const [deliverySummary] = await db.select({
      pending: sql<number>`sum(case when ${notificationDeliveries.status} = 'pending' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${notificationDeliveries.status} = 'failed' then 1 else 0 end)`,
      lastDeliveredAt: sql<number | null>`max(${notificationDeliveries.deliveredAt})`,
    }).from(notificationDeliveries)
    const pending = Number(deliverySummary?.pending ?? 0)
    const failed = Number(deliverySummary?.failed ?? 0)
    notifications = {
      status: pending > 0 || failed > 0 ? 'attention' : 'ok',
      pending,
      failed,
      lastDeliveredAt: deliverySummary?.lastDeliveredAt ?? null,
    }
  } catch {
    // The protected report deliberately exposes state, not raw database errors.
  }

  const backupConfig = readBackupConfig()
  const backupState = readBackupStatus()
  let backups: SystemHealthReport['backups'] = {
    status: backupConfig.enabled ? (backupState.state === 'error' ? 'error' : 'ok') : 'disabled',
    scheduleEnabled: backupConfig.enabled,
    state: backupState.state,
    storedBackups: null,
    latestBackupAt: null,
    lastCompletedAt: backupState.lastCompletedAt,
  }
  try {
    const stored = listBackups()
    backups = { ...backups, storedBackups: stored.length, latestBackupAt: stored[0]?.createdAt ?? null }
  } catch {
    backups.status = 'error'
  }

  const monitoringStatus: ComponentStatus = !scheduler.running || scheduler.lastTickFailed
    ? 'error'
    : scheduler.lastFailedChecks > 0 || (monitoringData.overdueMonitors ?? 0) > 0
      ? 'attention'
      : 'ok'

  return {
    status: database.status === 'ok' && monitoringStatus !== 'error' && backups.status !== 'error'
      ? 'healthy'
      : 'degraded',
    generatedAt: now,
    application: { status: 'ok', version: resolveAppVersion(), uptimeSeconds: Math.floor(process.uptime()) },
    database,
    monitoring: {
      status: monitoringStatus,
      schedulerRunning: scheduler.running,
      ...monitoringData,
      lastTickStartedAt: scheduler.lastStartedAt,
      lastTickCompletedAt: scheduler.lastCompletedAt,
      lastTickDurationMs: scheduler.lastDurationMs,
      lastTickDueMonitors: scheduler.lastDueMonitors,
      lastTickFailedChecks: scheduler.lastFailedChecks,
    },
    notifications,
    backups,
  }
}
