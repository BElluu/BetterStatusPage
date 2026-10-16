import { backupRunner } from './backup.js'

// Forwards to the runner in ../kit/backup.ts; kept so call sites do not change.
export { spawnBackupWorker, type BackupJob, type BackupWorkerOptions } from '@better-kit/backup'
export const { createBackup: createBackupInWorker, validateBackup: validateBackupInWorker } = backupRunner
