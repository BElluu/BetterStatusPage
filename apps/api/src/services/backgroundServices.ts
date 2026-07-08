import { restartBackupScheduler, stopBackupScheduler } from '../workers/backupScheduler.js'
import { startNotificationRetryWorker, stopNotificationRetryWorker } from '../workers/notificationRetryWorker.js'
import { startScheduler, stopScheduler } from '../workers/scheduler.js'

export interface BackgroundServices {
  startMonitorScheduler: () => void
  startBackupScheduler: () => void
  startNotificationRetryWorker: () => void
  stopMonitorScheduler: () => void
  stopBackupScheduler: () => void
  stopNotificationRetryWorker: () => void
}

const defaultServices: BackgroundServices = {
  startMonitorScheduler: startScheduler,
  startBackupScheduler: restartBackupScheduler,
  startNotificationRetryWorker,
  stopMonitorScheduler: stopScheduler,
  stopBackupScheduler,
  stopNotificationRetryWorker,
}

export function stopBackgroundServices(services: BackgroundServices = defaultServices): void {
  services.stopMonitorScheduler()
  services.stopBackupScheduler()
  services.stopNotificationRetryWorker()
}

export function startBackgroundServices(services: BackgroundServices = defaultServices): void {
  services.startMonitorScheduler()
  services.startBackupScheduler()
  services.startNotificationRetryWorker()
}
