import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { BackupManifest, BackupService } from './service.js'

export interface RestoreResult { restoredAt: number; safetyBackup: string | null }

/** Puts `source` at `target` by copying beside it and renaming, so a failure never leaves half a file. */
export function replaceFile(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const incoming = `${target}.restore-incoming`
  fs.copyFileSync(source, incoming)
  fs.renameSync(incoming, target)
}

function removeSqliteSidecars(dbPath: string): void {
  fs.rmSync(`${dbPath}-wal`, { force: true })
  fs.rmSync(`${dbPath}-shm`, { force: true })
}

/** The files around the database that a restore replaces, and how to put the old ones back. */
export interface RestoreExtras {
  /** Copies what is there now into `rollbackDir`. */
  save: (rollbackDir: string) => void
  /** Replaces what is there with what the backup holds (extracted into `extractedDir`). */
  apply: (extractedDir: string) => void
  /** Puts back what `save` kept (and removes what the failed restore created). */
  rollback: (rollbackDir: string) => void
}

export interface RestoreOptions<Manifest extends BackupManifest> {
  service: BackupService<Manifest>
  name: string
  /** How the application is called in the messages shown to its operator. */
  displayName: string
  databasePath: () => string
  /** Throws unless the application is stopped. */
  assertStopped: () => void
  /** The application's own database handle: opened to take the safety backup and to migrate what was restored. */
  database: { open: () => void; close: () => void; migrate: () => void }
  /** Called once the restore is about to replace files; the flags it captures describe what existed before. */
  extras: () => RestoreExtras
}

/**
 * Restores a backup over a stopped application. A safety backup of what is there now is taken first, and a failure
 * half way puts every replaced file back.
 */
export function createRestore<Manifest extends BackupManifest>(options: RestoreOptions<Manifest>) {
  const { service, database } = options

  /**
   * `prepare` runs before the backup is read (to set up the key it will need); `check` may refuse the backup by
   * throwing, once its manifest is known.
   */
  return async function restoreBackup(
    input: string,
    hooks: { prepare?: () => void; check?: (manifest: Manifest) => void } = {},
  ): Promise<RestoreResult> {
    options.assertStopped()
    hooks.prepare?.()
    const manifest = service.validateBackup(input)
    hooks.check?.(manifest)

    const dbPath = options.databasePath()
    if (fs.existsSync(dbPath)) {
      const lockCheck = new DatabaseSync(dbPath)
      try { lockCheck.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK') }
      catch { lockCheck.close(); throw new Error(`Database is in use. Stop ${options.displayName} before restoring.`) }
      lockCheck.close()
    }

    let safetyBackup: string | null = null
    if (fs.existsSync(dbPath)) {
      database.open()
      try { safetyBackup = (await service.createBackup()).filename } finally { database.close() }
    }

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${options.name}-restore-`))
    const rollback = fs.mkdtempSync(path.join(os.tmpdir(), `${options.name}-rollback-`))
    const hadDatabase = fs.existsSync(dbPath)
    const extras = options.extras()
    try {
      service.extractArchive(input, temp)
      if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, path.join(rollback, 'database.sqlite'))
      extras.save(rollback)

      try {
        removeSqliteSidecars(dbPath)
        replaceFile(path.join(temp, 'database.sqlite'), dbPath)
        extras.apply(temp)
        database.open()
        database.migrate()
        database.close()
      } catch (error) {
        database.close()
        removeSqliteSidecars(dbPath)
        const oldDb = path.join(rollback, 'database.sqlite')
        if (fs.existsSync(oldDb)) replaceFile(oldDb, dbPath)
        else if (!hadDatabase) fs.rmSync(dbPath, { force: true })
        extras.rollback(rollback)
        throw error
      }
      return { restoredAt: Date.now(), safetyBackup }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
      fs.rmSync(rollback, { recursive: true, force: true })
    }
  }
}
