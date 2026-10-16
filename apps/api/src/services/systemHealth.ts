import { sql } from 'drizzle-orm'
import { createSystemHealth, type HealthContributor, type SystemHealthReport as RuntimeReport } from '@better-kit/runtime'
import { db } from '../db/client.js'
import { monitors, notificationDeliveries } from '../db/schema.js'
import { updates } from '../kit/runtime.js'
import { resolveAppVersion } from '../version.js'
import { listBackups, readBackupConfig, readBackupStatus } from '../kit/backupService.js'
import { getSchedulerHealth } from '../workers/scheduler.js'

type ComponentStatus = 'ok' | 'attention' | 'error' | 'disabled'

/** The report as this application serves it: the runtime's parts plus the sections below. */
export interface SystemHealthReport extends RuntimeReport {
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

const monitoring: HealthContributor = {
  key: 'monitoring',
  critical: true,
  async collect({ now, databaseOk }) {
    const scheduler = getSchedulerHealth()
    let monitoringData: Pick<SystemHealthReport['monitoring'], 'configuredMonitors' | 'overdueMonitors' | 'lastMonitorCheckAt'> = {
      configuredMonitors: null,
      overdueMonitors: null,
      lastMonitorCheckAt: null,
    }
    if (databaseOk) {
      try {
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
      } catch {
        // The protected report deliberately exposes state, not raw database errors.
      }
    }
    const status: ComponentStatus = !scheduler.running || scheduler.lastTickFailed
      ? 'error'
      : scheduler.lastFailedChecks > 0 || (monitoringData.overdueMonitors ?? 0) > 0
        ? 'attention'
        : 'ok'
    return {
      status,
      schedulerRunning: scheduler.running,
      ...monitoringData,
      lastTickStartedAt: scheduler.lastStartedAt,
      lastTickCompletedAt: scheduler.lastCompletedAt,
      lastTickDurationMs: scheduler.lastDurationMs,
      lastTickDueMonitors: scheduler.lastDueMonitors,
      lastTickFailedChecks: scheduler.lastFailedChecks,
    }
  },
}

const notifications: HealthContributor = {
  key: 'notifications',
  critical: false,
  async collect({ databaseOk }) {
    let result: SystemHealthReport['notifications'] = { status: 'error', pending: null, failed: null, lastDeliveredAt: null }
    if (databaseOk) {
      try {
        const [deliverySummary] = await db.select({
          pending: sql<number>`sum(case when ${notificationDeliveries.status} = 'pending' then 1 else 0 end)`,
          failed: sql<number>`sum(case when ${notificationDeliveries.status} = 'failed' then 1 else 0 end)`,
          lastDeliveredAt: sql<number | null>`max(${notificationDeliveries.deliveredAt})`,
        }).from(notificationDeliveries)
        const pending = Number(deliverySummary?.pending ?? 0)
        const failed = Number(deliverySummary?.failed ?? 0)
        result = {
          status: pending > 0 || failed > 0 ? 'attention' : 'ok',
          pending,
          failed,
          lastDeliveredAt: deliverySummary?.lastDeliveredAt ?? null,
        }
      } catch {
        // The protected report deliberately exposes state, not raw database errors.
      }
    }
    return result
  },
}

const backups: HealthContributor = {
  key: 'backups',
  critical: true,
  collect() {
    const backupConfig = readBackupConfig()
    const backupState = readBackupStatus()
    let result: SystemHealthReport['backups'] = {
      status: backupConfig.enabled ? (backupState.state === 'error' ? 'error' : 'ok') : 'disabled',
      scheduleEnabled: backupConfig.enabled,
      state: backupState.state,
      storedBackups: null,
      latestBackupAt: null,
      lastCompletedAt: backupState.lastCompletedAt,
    }
    try {
      const stored = listBackups()
      result = { ...result, storedBackups: stored.length, latestBackupAt: stored[0]?.createdAt ?? null }
    } catch {
      result.status = 'error'
    }
    return result
  },
}

const systemHealth = createSystemHealth({
  db,
  version: () => resolveAppVersion(),
  update: () => updates.getAvailableUpdate(),
  contributors: [monitoring, notifications, backups],
})

export async function getSystemHealthReport(now = Date.now()): Promise<SystemHealthReport> {
  return await systemHealth.getSystemHealthReport(now) as SystemHealthReport
}

export const systemHealthRoutes = systemHealth.systemHealthRoutes
