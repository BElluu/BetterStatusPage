import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  collectFiles, createBackupRunner, createBackupService, createRestore, replaceFile,
  type BackupManifest as BaseManifest,
} from '@better-forge/backup'
import { currentProcessOwner, isOwnerAlive } from '@better-forge/runtime'
import { backupDir, databasePath, setupConfigPath, uploadDir } from '../config.js'
import { closeDb, initDb } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { assertAppStopped } from './appLock.js'
import { resolveAppVersion } from '../version.js'

export const BACKUP_FORMAT_VERSION = 1

/** What a backup of this application records besides the common fields. */
export interface BackupManifest extends BaseManifest {
  requiresVaultKey: boolean
  vaultKeyFingerprint: string | null
  files: { database: true; setup: boolean; uploads: number }
}

function keyFingerprint(): string | null {
  const key = process.env['VAULT_ENCRYPTION_KEY']
  return key ? crypto.createHash('sha256').update(key).digest('hex') : null
}

/** Backups of this application: the database, the setup file and the uploads. */
export const backup = createBackupService<BackupManifest>({
  name: 'bsp',
  // Archives have always started with this; it is what the restore recognises them by.
  magic: 'BSPBKP01',
  formatVersion: BACKUP_FORMAT_VERSION,
  backupDir,
  databasePath,
  appVersion: resolveAppVersion,
  processOwner: { current: currentProcessOwner, isAlive: isOwnerAlive },
  extras: () => {
    const uploads = collectFiles(uploadDir(), 'uploads')
    const setup = fs.existsSync(setupConfigPath())
    return {
      entries: [...uploads, ...(setup ? [{ name: 'setup.json', source: setupConfigPath() }] : [])],
      manifest: { requiresVaultKey: true, vaultKeyFingerprint: keyFingerprint(), files: { database: true, setup, uploads: uploads.length } },
    }
  },
})

export function currentVaultKeyMatches(manifest: BackupManifest): boolean | null {
  if (!manifest.vaultKeyFingerprint) return null
  return manifest.vaultKeyFingerprint === keyFingerprint()
}

/** Runs backups on a worker thread; development and tests (TypeScript sources) run them in the calling thread. */
export const backupRunner = createBackupRunner<BackupManifest>({
  service: backup,
  inline: import.meta.url.endsWith('.ts'),
  workerUrl: new URL('../workers/backupWorker.js', import.meta.url),
  moduleUrl: new URL('./backupService.js', import.meta.url).href,
})

const restore = createRestore<BackupManifest>({
  service: backup,
  name: 'bsp',
  displayName: 'BetterStatusPage',
  databasePath,
  assertStopped: assertAppStopped,
  database: { open: initDb, close: closeDb, migrate: runMigrations },
  extras: () => {
    const hadSetup = fs.existsSync(setupConfigPath())
    const hadUploads = fs.existsSync(uploadDir())
    return {
      save(rollbackDir) {
        if (fs.existsSync(setupConfigPath())) fs.copyFileSync(setupConfigPath(), path.join(rollbackDir, 'setup.json'))
        if (fs.existsSync(uploadDir())) fs.cpSync(uploadDir(), path.join(rollbackDir, 'uploads'), { recursive: true })
      },
      apply(extractedDir) {
        const restoredSetup = path.join(extractedDir, 'setup.json')
        if (fs.existsSync(restoredSetup)) replaceFile(restoredSetup, setupConfigPath())
        fs.rmSync(uploadDir(), { recursive: true, force: true })
        const restoredUploads = path.join(extractedDir, 'uploads')
        if (fs.existsSync(restoredUploads)) fs.cpSync(restoredUploads, uploadDir(), { recursive: true })
        else fs.mkdirSync(uploadDir(), { recursive: true })
      },
      rollback(rollbackDir) {
        const oldSetup = path.join(rollbackDir, 'setup.json')
        if (fs.existsSync(oldSetup)) replaceFile(oldSetup, setupConfigPath())
        else if (!hadSetup) fs.rmSync(setupConfigPath(), { force: true })
        fs.rmSync(uploadDir(), { recursive: true, force: true })
        const oldUploads = path.join(rollbackDir, 'uploads')
        if (fs.existsSync(oldUploads)) fs.cpSync(oldUploads, uploadDir(), { recursive: true })
        else if (!hadUploads) fs.rmSync(uploadDir(), { recursive: true, force: true })
      },
    }
  },
})

/** Restores a backup over the stopped application; the vault key it was made with must be supplied. */
export function restoreBackup(input: string, options: { vaultEncryptionKey: string }) {
  return restore(input, {
    prepare() {
      if (!/^[0-9a-fA-F]{64}$/.test(options.vaultEncryptionKey)) {
        throw new Error('VAULT_ENCRYPTION_KEY must be exactly 64 hexadecimal characters')
      }
      process.env['VAULT_ENCRYPTION_KEY'] = options.vaultEncryptionKey
    },
    check(manifest) {
      if (currentVaultKeyMatches(manifest) !== true) throw new Error('VAULT_ENCRYPTION_KEY does not match this backup')
    },
  })
}
