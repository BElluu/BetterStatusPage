import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { backupDir, databasePath, setupConfigPath, uploadDir } from '../config.js'
import { resolveAppVersion } from '../version.js'
import { createArchive, extractArchive, type ArchiveEntry } from './backupArchive.js'
import { currentProcessOwner, isOwnerAlive, type ProcessOwner } from './processLiveness.js'

export const BACKUP_FORMAT_VERSION = 1
let operation: Promise<unknown> | null = null

export interface BackupManifest {
  formatVersion: number
  createdAt: number
  appVersion: string
  databaseIntegrity: 'ok'
  requiresVaultKey: boolean
  vaultKeyFingerprint: string | null
  files: { database: true; setup: boolean; uploads: number }
}

export interface BackupInfo { filename: string; size: number; createdAt: number }
export interface BackupConfig { enabled: boolean; frequency: 'daily' | 'weekly'; hour: number; minute: number; weekday: number; retention: number }
export interface BackupStatus { state: 'idle' | 'running' | 'success' | 'error'; lastStartedAt: number | null; lastCompletedAt: number | null; lastFilename: string | null; lastError: string | null }
export const DEFAULT_BACKUP_CONFIG: BackupConfig = { enabled: false, frequency: 'daily', hour: 2, minute: 0, weekday: 0, retention: 7 }
export const DEFAULT_BACKUP_STATUS: BackupStatus = { state: 'idle', lastStartedAt: null, lastCompletedAt: null, lastFilename: null, lastError: null }

function quoteSql(value: string): string { return `'${value.replaceAll("'", "''")}'` }
/** Closes the handle even when the file is not SQLite, so temp-dir cleanup never hits a locked file. */
function checkIntegrity(file: string): void {
  const checkDb = new DatabaseSync(file, { readOnly: true })
  let result: string
  try {
    result = (checkDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
  } finally {
    checkDb.close()
  }
  if (result !== 'ok') throw new Error(`SQLite integrity check failed: ${result}`)
}
function keyFingerprint(): string | null {
  const key = process.env['VAULT_ENCRYPTION_KEY']
  return key ? crypto.createHash('sha256').update(key).digest('hex') : null
}
function configFile(): string { return path.join(backupDir(), 'config.json') }
function statusFile(): string { return path.join(backupDir(), 'status.json') }

export function readBackupConfig(): BackupConfig {
  try { return { ...DEFAULT_BACKUP_CONFIG, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Partial<BackupConfig> } }
  catch { return { ...DEFAULT_BACKUP_CONFIG } }
}

export function writeBackupConfig(config: BackupConfig): void {
  fs.mkdirSync(backupDir(), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 })
}

function readStoredBackupStatus(): BackupStatus {
  try { return { ...DEFAULT_BACKUP_STATUS, ...JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as Partial<BackupStatus> } }
  catch { return { ...DEFAULT_BACKUP_STATUS } }
}

export const INTERRUPTED_BACKUP_ERROR = 'Backup was interrupted before it finished'

/** A 'running' status without a live lock owner means the backup process died mid-run. */
export function readBackupStatus(): BackupStatus {
  const status = readStoredBackupStatus()
  if (status.state !== 'running' || isBackupLockHeld()) return status
  return { ...status, state: 'error', lastError: INTERRUPTED_BACKUP_ERROR }
}

function writeBackupStatus(status: BackupStatus): void {
  fs.mkdirSync(backupDir(), { recursive: true })
  fs.writeFileSync(statusFile(), JSON.stringify(status, null, 2), { mode: 0o600 })
}

function collectFiles(root: string, prefix: string): ArchiveEntry[] {
  if (!fs.existsSync(root)) return []
  const result: ArchiveEntry[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const source = path.join(root, entry.name)
    const name = `${prefix}/${entry.name}`
    if (entry.isDirectory()) result.push(...collectFiles(source, name))
    else if (entry.isFile()) result.push({ name, source })
  }
  return result
}

async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (operation) throw new Error('Another backup operation is already running')
  const current = work()
  operation = current
  try { return await current } finally { operation = null }
}

const LOCK_NAME = '.backup.lock'
/** A lock that cannot be parsed is only trusted briefly: it is either being written or left by an older version. */
const UNREADABLE_LOCK_GRACE_MS = 60_000
/** Hard ceiling, even for an owner that still looks alive (e.g. a stuck worker thread in this process). */
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000

interface BackupLockOwner extends ProcessOwner { startedAt: number }

/** One lock beside the shared status file, whatever output directory a backup writes to. */
function lockFile(): string { return path.join(backupDir(), LOCK_NAME) }

/** True while some live backup owns the lock; a crashed owner's lock reads as free. */
export function isBackupLockHeld(): boolean {
  const lock = lockFile()
  let stat: fs.Stats
  try { stat = fs.statSync(lock) } catch { return false }
  const age = Date.now() - stat.mtimeMs
  if (age >= MAX_LOCK_AGE_MS) return false
  let owner: Partial<BackupLockOwner>
  try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as Partial<BackupLockOwner> }
  catch { return age < UNREADABLE_LOCK_GRACE_MS }
  return isOwnerAlive(owner)
}

function acquireBackupLock(): () => void {
  const lock = lockFile()
  const owner: BackupLockOwner = { ...currentProcessOwner(), startedAt: Date.now() }
  const create = () => fs.writeFileSync(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
  try { create() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (isBackupLockHeld()) throw new Error('Another backup operation is already running', { cause: error })
    fs.rmSync(lock, { force: true })
    try { create() }
    catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another backup operation is already running', { cause: retryError })
      throw retryError
    }
  }
  return () => fs.rmSync(lock, { force: true })
}

export async function createBackup(outputDirectory = backupDir()): Promise<BackupInfo> {
  return exclusive(async () => {
    fs.mkdirSync(outputDirectory, { recursive: true })
    fs.mkdirSync(backupDir(), { recursive: true })
    // Lock first: a rejected concurrent attempt must not overwrite the running backup's status.
    const releaseLock = acquireBackupLock()
    const startedAt = Date.now()
    let temp: string | null = null
    let partial: string | null = null
    try {
      writeBackupStatus({ ...readStoredBackupStatus(), state: 'running', lastStartedAt: startedAt, lastError: null })
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-backup-'))
      const snapshot = path.join(temp, 'database.sqlite')
      const sourceDb = new DatabaseSync(databasePath())
      try { sourceDb.exec(`VACUUM INTO ${quoteSql(snapshot)}`) } finally { sourceDb.close() }
      checkIntegrity(snapshot)

      const uploads = collectFiles(uploadDir(), 'uploads')
      const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: Date.now(),
        appVersion: resolveAppVersion(),
        databaseIntegrity: 'ok',
        requiresVaultKey: true,
        vaultKeyFingerprint: keyFingerprint(),
        files: { database: true, setup: fs.existsSync(setupConfigPath()), uploads: uploads.length },
      }
      const manifestPath = path.join(temp, 'manifest.json')
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      const entries: ArchiveEntry[] = [
        { name: 'manifest.json', source: manifestPath },
        { name: 'database.sqlite', source: snapshot },
        ...uploads,
      ]
      if (manifest.files.setup) entries.push({ name: 'setup.json', source: setupConfigPath() })
      const filename = `bsp-backup-${manifest.createdAt}.backup`
      partial = path.join(outputDirectory, `${filename}.partial`)
      const target = path.join(outputDirectory, filename)
      createArchive(partial, entries)
      fs.renameSync(partial, target)
      const stat = fs.statSync(target)
      writeBackupStatus({ state: 'success', lastStartedAt: startedAt, lastCompletedAt: Date.now(), lastFilename: filename, lastError: null })
      return { filename, size: stat.size, createdAt: manifest.createdAt }
    } catch (error) {
      try {
        writeBackupStatus({ ...readStoredBackupStatus(), state: 'error', lastStartedAt: startedAt, lastCompletedAt: Date.now(), lastError: error instanceof Error ? error.message : String(error) })
      } catch { /* keep the original failure */ }
      throw error
    } finally {
      if (partial) fs.rmSync(partial, { force: true })
      if (temp) fs.rmSync(temp, { recursive: true, force: true })
      releaseLock()
    }
  })
}

export function validateBackup(input: string): BackupManifest {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-verify-'))
  try {
    const entries = extractArchive(input, temp)
    if (!entries.includes('manifest.json') || !entries.includes('database.sqlite')) throw new Error('Backup is missing required files')
    const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'manifest.json'), 'utf8')) as BackupManifest
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error(`Unsupported backup version: ${manifest.formatVersion}`)
    checkIntegrity(path.join(temp, 'database.sqlite'))
    return manifest
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(backupDir())) return []
  return fs.readdirSync(backupDir()).filter((name) => /^bsp-backup-\d+\.backup$/.test(name)).map((filename) => {
    const stat = fs.statSync(path.join(backupDir(), filename))
    return { filename, size: stat.size, createdAt: stat.mtimeMs }
  }).sort((a, b) => b.createdAt - a.createdAt)
}

export function backupFile(filename: string): string {
  if (!/^bsp-backup-\d+\.backup$/.test(filename)) throw new Error('Invalid backup filename')
  return path.join(backupDir(), filename)
}

export function applyRetention(keep: number): void {
  for (const item of listBackups().slice(Math.max(1, keep))) fs.rmSync(backupFile(item.filename), { force: true })
}

export function currentVaultKeyMatches(manifest: BackupManifest): boolean | null {
  if (!manifest.vaultKeyFingerprint) return null
  return manifest.vaultKeyFingerprint === keyFingerprint()
}

export { extractArchive, databasePath, setupConfigPath, uploadDir }
