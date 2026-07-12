import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { backupDir, databasePath, setupConfigPath, uploadDir } from '../config.js'
import { createArchive, extractArchive, type ArchiveEntry } from './backupArchive.js'

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

export function readBackupStatus(): BackupStatus {
  try { return { ...DEFAULT_BACKUP_STATUS, ...JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as Partial<BackupStatus> } }
  catch { return { ...DEFAULT_BACKUP_STATUS } }
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

export async function createBackup(outputDirectory = backupDir()): Promise<BackupInfo> {
  return exclusive(async () => {
    const startedAt = Date.now()
    writeBackupStatus({ ...readBackupStatus(), state: 'running', lastStartedAt: startedAt, lastError: null })
    fs.mkdirSync(outputDirectory, { recursive: true })
    const lock = path.join(outputDirectory, '.backup.lock')
    let lockFd: number
    try { lockFd = fs.openSync(lock, 'wx', 0o600) }
    catch {
      const age = Date.now() - fs.statSync(lock).mtimeMs
      if (age < 24 * 60 * 60 * 1000) throw new Error('Another backup operation is already running')
      fs.rmSync(lock, { force: true })
      lockFd = fs.openSync(lock, 'wx', 0o600)
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-backup-'))
    const snapshot = path.join(temp, 'database.sqlite')
    let partial: string | null = null
    try {
      const sourceDb = new DatabaseSync(databasePath())
      try { sourceDb.exec(`VACUUM INTO ${quoteSql(snapshot)}`) } finally { sourceDb.close() }
      const checkDb = new DatabaseSync(snapshot, { readOnly: true })
      const integrity = checkDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      checkDb.close()
      if (integrity.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`)

      const uploads = collectFiles(uploadDir(), 'uploads')
      const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: Date.now(),
        appVersion: process.env['APP_VERSION'] ?? process.env['npm_package_version'] ?? '0.1.0',
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
      writeBackupStatus({ ...readBackupStatus(), state: 'error', lastStartedAt: startedAt, lastCompletedAt: Date.now(), lastError: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      if (partial) fs.rmSync(partial, { force: true })
      fs.rmSync(temp, { recursive: true, force: true })
      fs.closeSync(lockFd)
      fs.rmSync(lock, { force: true })
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
    const checkDb = new DatabaseSync(path.join(temp, 'database.sqlite'), { readOnly: true })
    const integrity = checkDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    checkDb.close()
    if (integrity.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`)
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
