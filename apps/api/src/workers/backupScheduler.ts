import { backupScheduler } from '../kit/backup.js'

// Forwards to the scheduler in ../kit/backup.ts; kept so call sites do not change.
export const restartBackupScheduler = backupScheduler.restart
export const stopBackupScheduler = backupScheduler.stop
