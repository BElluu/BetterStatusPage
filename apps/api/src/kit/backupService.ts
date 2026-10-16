import { backup, BACKUP_FORMAT_VERSION, currentVaultKeyMatches } from './backup.js'
import { databasePath, setupConfigPath, uploadDir } from '../config.js'

// Forwards to the backup service in ../kit/backup.ts; kept so call sites do not change.
export { BACKUP_FORMAT_VERSION, currentVaultKeyMatches, databasePath, setupConfigPath, uploadDir }
export { DEFAULT_BACKUP_CONFIG, DEFAULT_BACKUP_STATUS, INTERRUPTED_BACKUP_ERROR } from '@better-kit/backup'
export type { BackupConfig, BackupInfo, BackupStatus } from '@better-kit/backup'
export type { BackupManifest } from './backup.js'

export const {
  createBackup, validateBackup, listBackups, backupFile, applyRetention,
  readBackupConfig, writeBackupConfig, readBackupStatus, isBackupLockHeld, extractArchive,
} = backup
