import { createBackupRoutes, createBackupScheduler } from '@better-kit/backup'
import { requestIdentity } from '../middleware/auth.js'
import { audit } from './audit.js'
import { backup, backupRunner, currentVaultKeyMatches, type BackupManifest } from './backup.js'

/** Makes a scheduled backup and prunes old ones. */
export const backupScheduler = createBackupScheduler({
  readConfig: backup.readBackupConfig,
  run: async (config) => {
    await backupRunner.createBackup()
    backup.applyRetention(config.retention)
  },
})

/** The admin routes of the backups (list, create, schedule, download, delete, verify). */
export const backupRoutes = createBackupRoutes<BackupManifest>({
  service: backup,
  audit,
  identity: requestIdentity,
  createBackup: () => backupRunner.createBackup(),
  validateBackup: (input) => backupRunner.validateBackup(input),
  restartScheduler: backupScheduler.restart,
  describeManifest: (manifest) => ({ vaultKeyMatches: currentVaultKeyMatches(manifest) }),
})
