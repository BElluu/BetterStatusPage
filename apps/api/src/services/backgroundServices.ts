import { backupScheduler } from '../kit/backupRoutes.js'
import { startNotificationRetryWorker, stopNotificationRetryWorker } from '../workers/notificationRetryWorker.js'
import { startScheduler, stopScheduler } from '../workers/scheduler.js'
import { startUpdateCheck, stopUpdateCheck } from '../kit/updateCheck.js'

export interface BackgroundServices {
  startMonitorScheduler: () => void
  startBackupScheduler: () => void
  startNotificationRetryWorker: () => void
  startUpdateCheck: () => void
  stopMonitorScheduler: () => void
  stopBackupScheduler: () => void
  stopNotificationRetryWorker: () => void
  stopUpdateCheck: () => void
}

const defaultServices: BackgroundServices = {
  startMonitorScheduler: startScheduler,
  startBackupScheduler: backupScheduler.restart,
  startNotificationRetryWorker,
  startUpdateCheck,
  stopMonitorScheduler: stopScheduler,
  stopBackupScheduler: backupScheduler.stop,
  stopNotificationRetryWorker,
  stopUpdateCheck,
}

export function stopBackgroundServices(services: BackgroundServices = defaultServices): void {
  services.stopMonitorScheduler()
  services.stopBackupScheduler()
  services.stopNotificationRetryWorker()
  services.stopUpdateCheck()
}

export function startBackgroundServices(services: BackgroundServices = defaultServices): void {
  services.startMonitorScheduler()
  services.startBackupScheduler()
  services.startNotificationRetryWorker()
  services.startUpdateCheck()
}
