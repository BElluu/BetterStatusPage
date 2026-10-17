import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createArchiveFormat, type ArchiveEntry } from './archive.js'

/** What every backup records about itself; an application adds its own fields to the manifest. */
export interface BackupManifest {
  formatVersion: number
  createdAt: number
  appVersion: string
  databaseIntegrity: 'ok'
}

export interface BackupInfo { filename: string; size: number; createdAt: number }
export interface BackupConfig { enabled: boolean; frequency: 'daily' | 'weekly'; hour: number; minute: number; weekday: number; retention: number }
export interface BackupStatus { state: 'idle' | 'running' | 'success' | 'error'; lastStartedAt: number | null; lastCompletedAt: number | null; lastFilename: string | null; lastError: string | null }

export const DEFAULT_BACKUP_CONFIG: BackupConfig = { enabled: false, frequency: 'daily', hour: 2, minute: 0, weekday: 0, retention: 7 }
export const DEFAULT_BACKUP_STATUS: BackupStatus = { state: 'idle', lastStartedAt: null, lastCompletedAt: null, lastFilename: null, lastError: null }

export const INTERRUPTED_BACKUP_ERROR = 'Backup was interrupted before it finished'

/** Who holds the backup lock: enough to tell whether that process may still be running. */
export interface ProcessOwner { pid: number; processStartedAt: number }

export interface BackupServiceOptions<Manifest extends BackupManifest> {
  /** Names the files of this product: `<name>-backup-<time>.backup`, and the temporary directories. */
  name: string
  /** The first bytes of the archive; they identify archives of this product. */
  magic: string
  /** Version of the archive layout; an archive of another version is refused. */
  formatVersion: number
  /** Where backups, their schedule and their status are kept. */
  backupDir: () => string
  /** The SQLite database to back up. */
  databasePath: () => string
  appVersion: () => string
  processOwner: {
    current: () => ProcessOwner
    isAlive: (owner: Partial<ProcessOwner>) => boolean
  }
  /** What goes into the archive besides the database, and the manifest fields that describe it. */
  extras: () => { entries: ArchiveEntry[]; manifest: Omit<Manifest, keyof BackupManifest> }
}

/** Lists the files below `root` as archive entries named `<prefix>/<relative path>`. */
export function collectFiles(root: string, prefix: string): ArchiveEntry[] {
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

const LOCK_NAME = '.backup.lock'
/** A lock that cannot be parsed is only trusted briefly: it is either being written or left by an older version. */
const UNREADABLE_LOCK_GRACE_MS = 60_000
/** Hard ceiling, even for an owner that still looks alive (e.g. a stuck worker thread in this process). */
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000

interface BackupLockOwner extends ProcessOwner { startedAt: number }

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

/**
 * Backups of a SQLite database and the files around it: the archive, its verification, the lock that keeps two
 * backups apart, the schedule and status files, and retention. All state is in the returned closure.
 */
export function createBackupService<Manifest extends BackupManifest = BackupManifest>(options: BackupServiceOptions<Manifest>) {
  const { createArchive, extractArchive } = createArchiveFormat({ magic: options.magic })
  const { backupDir } = options
  const filePattern = new RegExp(`^${options.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-backup-\\d+\\.backup$`)
  let operation: Promise<unknown> | null = null

  const configFile = () => path.join(backupDir(), 'config.json')
  const statusFile = () => path.join(backupDir(), 'status.json')
  const lockFile = () => path.join(backupDir(), LOCK_NAME)

  function readBackupConfig(): BackupConfig {
    try { return { ...DEFAULT_BACKUP_CONFIG, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Partial<BackupConfig> } }
    catch { return { ...DEFAULT_BACKUP_CONFIG } }
  }

  function writeBackupConfig(config: BackupConfig): void {
    fs.mkdirSync(backupDir(), { recursive: true })
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 })
  }

  function readStoredBackupStatus(): BackupStatus {
    try { return { ...DEFAULT_BACKUP_STATUS, ...JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as Partial<BackupStatus> } }
    catch { return { ...DEFAULT_BACKUP_STATUS } }
  }

  /** A 'running' status without a live lock owner means the backup process died mid-run. */
  function readBackupStatus(): BackupStatus {
    const status = readStoredBackupStatus()
    if (status.state !== 'running' || isBackupLockHeld()) return status
    return { ...status, state: 'error', lastError: INTERRUPTED_BACKUP_ERROR }
  }

  function writeBackupStatus(status: BackupStatus): void {
    fs.mkdirSync(backupDir(), { recursive: true })
    fs.writeFileSync(statusFile(), JSON.stringify(status, null, 2), { mode: 0o600 })
  }

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (operation) throw new Error('Another backup operation is already running')
    const current = work()
    operation = current
    try { return await current } finally { operation = null }
  }

  /** True while some live backup owns the lock; a crashed owner's lock reads as free. */
  function isBackupLockHeld(): boolean {
    const lock = lockFile()
    let stat: fs.Stats
    try { stat = fs.statSync(lock) } catch { return false }
    const age = Date.now() - stat.mtimeMs
    if (age >= MAX_LOCK_AGE_MS) return false
    let owner: Partial<BackupLockOwner>
    try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as Partial<BackupLockOwner> }
    catch { return age < UNREADABLE_LOCK_GRACE_MS }
    return options.processOwner.isAlive(owner)
  }

  function acquireBackupLock(): () => void {
    const lock = lockFile()
    const owner: BackupLockOwner = { ...options.processOwner.current(), startedAt: Date.now() }
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

  async function createBackup(outputDirectory = backupDir()): Promise<BackupInfo> {
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
        temp = fs.mkdtempSync(path.join(os.tmpdir(), `${options.name}-backup-`))
        const snapshot = path.join(temp, 'database.sqlite')
        const sourceDb = new DatabaseSync(options.databasePath())
        try { sourceDb.exec(`VACUUM INTO ${quoteSql(snapshot)}`) } finally { sourceDb.close() }
        checkIntegrity(snapshot)

        const extras = options.extras()
        const manifest = {
          formatVersion: options.formatVersion,
          createdAt: Date.now(),
          appVersion: options.appVersion(),
          databaseIntegrity: 'ok',
          ...extras.manifest,
        } as Manifest
        const manifestPath = path.join(temp, 'manifest.json')
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
        const entries: ArchiveEntry[] = [
          { name: 'manifest.json', source: manifestPath },
          { name: 'database.sqlite', source: snapshot },
          ...extras.entries,
        ]
        const filename = `${options.name}-backup-${manifest.createdAt}.backup`
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

  function validateBackup(input: string): Manifest {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${options.name}-verify-`))
    try {
      const entries = extractArchive(input, temp)
      if (!entries.includes('manifest.json') || !entries.includes('database.sqlite')) throw new Error('Backup is missing required files')
      const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'manifest.json'), 'utf8')) as Manifest
      if (manifest.formatVersion !== options.formatVersion) throw new Error(`Unsupported backup version: ${manifest.formatVersion}`)
      checkIntegrity(path.join(temp, 'database.sqlite'))
      return manifest
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  }

  function listBackups(): BackupInfo[] {
    if (!fs.existsSync(backupDir())) return []
    return fs.readdirSync(backupDir()).filter((name) => filePattern.test(name)).map((filename) => {
      const stat = fs.statSync(path.join(backupDir(), filename))
      return { filename, size: stat.size, createdAt: stat.mtimeMs }
    }).sort((a, b) => b.createdAt - a.createdAt)
  }

  function backupFile(filename: string): string {
    if (!filePattern.test(filename)) throw new Error('Invalid backup filename')
    return path.join(backupDir(), filename)
  }

  function applyRetention(keep: number): void {
    for (const item of listBackups().slice(Math.max(1, keep))) fs.rmSync(backupFile(item.filename), { force: true })
  }

  return {
    createBackup, validateBackup, listBackups, backupFile, applyRetention,
    readBackupConfig, writeBackupConfig, readBackupStatus, isBackupLockHeld,
    extractArchive, createArchive,
  }
}

export type BackupService<Manifest extends BackupManifest = BackupManifest> = ReturnType<typeof createBackupService<Manifest>>
