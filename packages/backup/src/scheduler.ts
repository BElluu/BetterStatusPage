import cron, { type ScheduledTask } from 'node-cron'
import type { BackupConfig } from './service.js'

export interface BackupSchedulerOptions {
  readConfig: () => BackupConfig
  /** Makes one scheduled backup (and prunes old ones). A rejection is logged, never thrown. */
  run: (config: BackupConfig) => Promise<unknown>
  /** Prefix of the lines it logs. */
  logPrefix?: string
}

/** The cron expression of a schedule: every day, or one weekday, at the given time. */
export function scheduleExpression(config: BackupConfig): string {
  return config.frequency === 'weekly' ? `${config.minute} ${config.hour} * * ${config.weekday}` : `${config.minute} ${config.hour} * * *`
}

/** Runs a backup on the schedule the configuration describes; `restart` picks up a changed configuration. */
export function createBackupScheduler(options: BackupSchedulerOptions) {
  const prefix = options.logPrefix ?? '[backup]'
  let task: ScheduledTask | null = null

  function stop(): void {
    task?.destroy()
    task = null
  }

  function restart(): void {
    stop()
    const config = options.readConfig()
    if (!config.enabled) return
    const expression = scheduleExpression(config)
    task = cron.schedule(expression, () => {
      options.run(config).catch((error) => console.error(`${prefix} scheduled backup failed:`, error))
    })
    console.log(`${prefix} Scheduler started: ${expression}`)
  }

  return { restart, stop }
}
