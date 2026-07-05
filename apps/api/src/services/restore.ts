import fs from 'fs'
import path from 'path'
import os from 'os'
import { DatabaseSync } from 'node:sqlite'
import { closeDb, initDb } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { createBackup, currentVaultKeyMatches, databasePath, extractArchive, setupConfigPath, uploadDir, validateBackup } from './backup.js'
import { assertAppStopped } from './appLock.js'

export interface RestoreResult { restoredAt: number; safetyBackup: string | null }

function replaceFile(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const incoming = `${target}.restore-incoming`
  fs.copyFileSync(source, incoming)
  fs.renameSync(incoming, target)
}

function removeSqliteSidecars(dbPath: string): void {
  fs.rmSync(`${dbPath}-wal`, { force: true })
  fs.rmSync(`${dbPath}-shm`, { force: true })
}

export async function restoreBackup(input: string, options: { vaultEncryptionKey: string }): Promise<RestoreResult> {
  assertAppStopped()
  if (!/^[0-9a-fA-F]{64}$/.test(options.vaultEncryptionKey)) {
    throw new Error('VAULT_ENCRYPTION_KEY must be exactly 64 hexadecimal characters')
  }
  process.env['VAULT_ENCRYPTION_KEY'] = options.vaultEncryptionKey
  const manifest = validateBackup(input)
  if (currentVaultKeyMatches(manifest) !== true) {
    throw new Error('VAULT_ENCRYPTION_KEY does not match this backup')
  }

  const dbPath = databasePath()
  if (fs.existsSync(dbPath)) {
    const lockCheck = new DatabaseSync(dbPath)
    try { lockCheck.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK') }
    catch { lockCheck.close(); throw new Error('Database is in use. Stop BetterStatusPage before restoring.') }
    lockCheck.close()
  }

  let safetyBackup: string | null = null
  if (fs.existsSync(dbPath)) {
    initDb()
    try { safetyBackup = (await createBackup()).filename } finally { closeDb() }
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-restore-'))
  const rollback = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-rollback-'))
  const hadDatabase = fs.existsSync(dbPath)
  const hadSetup = fs.existsSync(setupConfigPath())
  const hadUploads = fs.existsSync(uploadDir())
  try {
    extractArchive(input, temp)
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, path.join(rollback, 'database.sqlite'))
    if (fs.existsSync(setupConfigPath())) fs.copyFileSync(setupConfigPath(), path.join(rollback, 'setup.json'))
    if (fs.existsSync(uploadDir())) fs.cpSync(uploadDir(), path.join(rollback, 'uploads'), { recursive: true })

    try {
      removeSqliteSidecars(dbPath)
      replaceFile(path.join(temp, 'database.sqlite'), dbPath)
      const restoredSetup = path.join(temp, 'setup.json')
      if (fs.existsSync(restoredSetup)) replaceFile(restoredSetup, setupConfigPath())
      fs.rmSync(uploadDir(), { recursive: true, force: true })
      const restoredUploads = path.join(temp, 'uploads')
      if (fs.existsSync(restoredUploads)) fs.cpSync(restoredUploads, uploadDir(), { recursive: true })
      else fs.mkdirSync(uploadDir(), { recursive: true })
      initDb()
      runMigrations()
      closeDb()
    } catch (error) {
      closeDb()
      removeSqliteSidecars(dbPath)
      const oldDb = path.join(rollback, 'database.sqlite')
      if (fs.existsSync(oldDb)) replaceFile(oldDb, dbPath)
      else if (!hadDatabase) fs.rmSync(dbPath, { force: true })
      const oldSetup = path.join(rollback, 'setup.json')
      if (fs.existsSync(oldSetup)) replaceFile(oldSetup, setupConfigPath())
      else if (!hadSetup) fs.rmSync(setupConfigPath(), { force: true })
      fs.rmSync(uploadDir(), { recursive: true, force: true })
      const oldUploads = path.join(rollback, 'uploads')
      if (fs.existsSync(oldUploads)) fs.cpSync(oldUploads, uploadDir(), { recursive: true })
      else if (!hadUploads) fs.rmSync(uploadDir(), { recursive: true, force: true })
      throw error
    }
    return { restoredAt: Date.now(), safetyBackup }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
    fs.rmSync(rollback, { recursive: true, force: true })
  }
}
