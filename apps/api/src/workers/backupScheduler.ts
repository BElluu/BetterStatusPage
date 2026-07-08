import cron, { type ScheduledTask } from 'node-cron'
import { applyRetention, readBackupConfig } from '../services/backup.js'
import { createBackupInWorker } from '../services/backupRunner.js'

let task: ScheduledTask | null = null

export function restartBackupScheduler(): void {
  stopBackupScheduler()
  const config = readBackupConfig()
  if (!config.enabled) return
  const expression = config.frequency === 'weekly' ? `${config.minute} ${config.hour} * * ${config.weekday}` : `${config.minute} ${config.hour} * * *`
  task = cron.schedule(expression, () => {
    createBackupInWorker().then(() => applyRetention(config.retention)).catch((error) => console.error('[backup] scheduled backup failed:', error))
  })
  console.log(`[backup] Scheduler started: ${expression}`)
}

export function stopBackupScheduler(): void {
  task?.destroy()
  task = null
}
