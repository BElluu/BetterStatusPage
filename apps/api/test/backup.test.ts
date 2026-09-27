import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import fs from 'fs'
import path from 'path'
import { closeDb, sqlite } from '../src/db/client.js'
import { spawnSync } from 'child_process'
import { createBackup, currentVaultKeyMatches, INTERRUPTED_BACKUP_ERROR, isBackupLockHeld, listBackups, readBackupStatus, validateBackup, type BackupManifest } from '../src/services/backup.js'
import { spawnBackupWorker } from '../src/services/backupRunner.js'
import { PROCESS_STARTED_AT } from '../src/services/processLiveness.js'
import { restoreBackup } from '../src/services/restore.js'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { backupRoutes } from '../src/routes/backups.js'
import { createArchive } from '../src/services/backupArchive.js'
import { acquireAppLock, assertAppStopped } from '../src/services/appLock.js'
import { resolveAppVersion } from '../src/version.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

let testDb: TestDb | null = null
let temp: string | null = null
const VAULT_KEY = 'a'.repeat(64)
function setupPaths() {
  testDb = createTestDb('bsp-backup-test-', 'db.sqlite')
  temp = testDb.dir
  process.env['DATA_DIR'] = temp
  process.env['UPLOAD_DIR'] = path.join(temp, 'uploads')
  process.env['SETUP_CONFIG_PATH'] = path.join(temp, 'setup.json')
  process.env['BACKUP_DIR'] = path.join(temp, 'backups')
  process.env['VAULT_ENCRYPTION_KEY'] = VAULT_KEY
  initTestDb()
}

afterEach(() => {
  if (testDb) teardownTestDb(testDb)
  else closeDb()
  testDb = null
  temp = null
})

describe('backup and restore', () => {
  it('creates a consistent archive with setup and uploads', async () => {
    setupPaths()
    fs.writeFileSync(process.env['SETUP_CONFIG_PATH']!, '{"setupComplete":true}')
    fs.mkdirSync(process.env['UPLOAD_DIR']!, { recursive: true })
    fs.writeFileSync(path.join(process.env['UPLOAD_DIR']!, 'logo.png'), 'image')
    sqlite.exec("INSERT INTO users(email,password_hash,role,created_at) VALUES ('backup@example.test','hash','admin',1)")

    const created = await createBackup()
    assert.match(created.filename, /^bsp-backup-\d+\.backup$/)
    const backupPath = path.join(process.env['BACKUP_DIR']!, created.filename)
    const manifest = validateBackup(backupPath)
    assert.equal(manifest.databaseIntegrity, 'ok')
    assert.equal(manifest.appVersion, resolveAppVersion())
    assert.equal(manifest.files.setup, true)
    assert.equal(manifest.files.uploads, 1)
    assert.equal(currentVaultKeyMatches(manifest), true)
    assert.equal(listBackups().length, 1)

    const corrupted = path.join(temp!, 'corrupted.backup')
    const bytes = fs.readFileSync(backupPath)
    bytes[bytes.length - 5] ^= 0xff
    fs.writeFileSync(corrupted, bytes)
    assert.throws(() => validateBackup(corrupted), /Checksum mismatch/)

    const source = path.join(temp!, 'source.txt')
    fs.writeFileSync(source, 'unsafe')
    assert.throws(() => createArchive(path.join(temp!, 'unsafe.backup'), [{ name: '../escape', source }]), /Unsafe archive path/)
  })

  it('restores the database and uploads and creates a safety backup', async () => {
    setupPaths()
    fs.writeFileSync(process.env['SETUP_CONFIG_PATH']!, '{"setupComplete":true}')
    fs.mkdirSync(process.env['UPLOAD_DIR']!, { recursive: true })
    fs.writeFileSync(path.join(process.env['UPLOAD_DIR']!, 'logo.png'), 'original')
    sqlite.exec("INSERT INTO users(email,password_hash,role,created_at) VALUES ('original@example.test','hash','admin',1)")
    const created = await createBackup()
    const backupPath = path.join(process.env['BACKUP_DIR']!, created.filename)

    sqlite.exec("UPDATE users SET email='changed@example.test'")
    fs.writeFileSync(path.join(process.env['UPLOAD_DIR']!, 'logo.png'), 'changed')
    closeDb()
    const result = await restoreBackup(backupPath, { vaultEncryptionKey: VAULT_KEY })
    assert.ok(result.safetyBackup)

    const restored = new (await import('node:sqlite')).DatabaseSync(process.env['DATABASE_PATH']!, { readOnly: true })
    assert.equal((restored.prepare('SELECT email FROM users').get() as { email: string }).email, 'original@example.test')
    restored.close()
    assert.equal(fs.readFileSync(path.join(process.env['UPLOAD_DIR']!, 'logo.png'), 'utf8'), 'original')
  })

  it('rejects a backup when the vault key differs', async () => {
    setupPaths()
    const created = await createBackup()
    const backupPath = path.join(process.env['BACKUP_DIR']!, created.filename)
    closeDb()
    await assert.rejects(() => restoreBackup(backupPath, { vaultEncryptionKey: 'b'.repeat(64) }), /does not match/)
  })

  it('refuses to restore while the application lock is active', async () => {
    setupPaths()
    const created = await createBackup()
    const backupPath = path.join(process.env['BACKUP_DIR']!, created.filename)
    closeDb()
    const release = acquireAppLock()
    try { await assert.rejects(() => restoreBackup(backupPath, { vaultEncryptionKey: VAULT_KEY }), /still running/) }
    finally { release() }
  })

  it('creates and manages backups through the admin API', async () => {
    setupPaths()
    const app = Fastify({ logger: false })
    await app.register(multipart)
    app.addHook('preHandler', async (request) => { request.user = { userId: 1, email: 'admin@example.test', role: 'admin' } })
    await app.register(backupRoutes, { prefix: '/backups' })
    await app.ready()
    try {
      const created = await app.inject({ method: 'POST', url: '/backups' })
      assert.equal(created.statusCode, 200, created.body)
      const listing = await app.inject({ url: '/backups' })
      assert.equal(listing.json().backups.length, 1)
      assert.equal(listing.json().status.state, 'success')
      const config = await app.inject({ method: 'PUT', url: '/backups/config', payload: { enabled: false, frequency: 'weekly', hour: 3, minute: 45, weekday: 1, retention: 5 } })
      assert.equal(config.statusCode, 200)
      assert.equal(config.json().minute, 45)
      const filename = created.json().filename as string
      assert.equal((await app.inject({ method: 'GET', url: `/backups/${filename}/download` })).statusCode, 200)
      assert.equal((await app.inject({ method: 'DELETE', url: `/backups/${filename}` })).statusCode, 400)
      assert.equal((await app.inject({ method: 'DELETE', url: `/backups/${filename}?confirm=${encodeURIComponent(filename)}` })).statusCode, 204)
    } finally { await app.close() }
  })
})

/** A pid that certainly belongs to no running process: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  assert.ok(child.pid)
  return child.pid
}

function writeLock(owner: Record<string, unknown>): string {
  fs.mkdirSync(process.env['BACKUP_DIR']!, { recursive: true })
  const lock = path.join(process.env['BACKUP_DIR']!, '.backup.lock')
  fs.writeFileSync(lock, JSON.stringify(owner))
  return lock
}

function writeStatus(status: Record<string, unknown>): void {
  fs.mkdirSync(process.env['BACKUP_DIR']!, { recursive: true })
  fs.writeFileSync(path.join(process.env['BACKUP_DIR']!, 'status.json'), JSON.stringify(status))
}

function multipartBody(file: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----bsp-test-boundary'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.backup"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

describe('backup lock and status', () => {
  it('reclaims a lock left by a crashed process', async () => {
    setupPaths()
    const lock = writeLock({ pid: deadPid(), processStartedAt: 0, startedAt: Date.now() })
    assert.equal(isBackupLockHeld(), false)
    await createBackup()
    assert.equal(fs.existsSync(lock), false)
    assert.equal(readBackupStatus().state, 'success')
  })

  it('reclaims a lock left by an earlier run that reused this pid', async () => {
    setupPaths()
    writeLock({ pid: process.pid, processStartedAt: PROCESS_STARTED_AT - 60_000, startedAt: Date.now() })
    assert.equal(isBackupLockHeld(), false)
    await createBackup()
  })

  it('refuses while a live process owns the lock without touching its status', async () => {
    setupPaths()
    const running = { state: 'running', lastStartedAt: 123, lastCompletedAt: null, lastFilename: null, lastError: null }
    writeStatus(running)
    const lock = writeLock({ pid: process.ppid, processStartedAt: 0, startedAt: Date.now() })
    assert.equal(isBackupLockHeld(), true)
    await assert.rejects(() => createBackup(), /already running/)
    assert.deepEqual(readBackupStatus(), running)
    assert.equal(fs.existsSync(lock), true)
  })

  it('reports a running status without a live lock as interrupted', () => {
    setupPaths()
    writeStatus({ state: 'running', lastStartedAt: 123, lastCompletedAt: null, lastFilename: null, lastError: null })
    assert.deepEqual(readBackupStatus(), { state: 'error', lastStartedAt: 123, lastCompletedAt: null, lastFilename: null, lastError: INTERRUPTED_BACKUP_ERROR })
    writeLock({ pid: deadPid(), processStartedAt: 0, startedAt: Date.now() })
    assert.equal(readBackupStatus().state, 'error')
  })

  it('records a failed backup as an error and releases the lock', async () => {
    setupPaths()
    closeDb()
    process.env['DATABASE_PATH'] = path.join(temp!, 'missing', 'nested', 'db.sqlite')
    await assert.rejects(() => createBackup())
    const status = readBackupStatus()
    assert.equal(status.state, 'error')
    assert.ok(status.lastError)
    assert.equal(fs.existsSync(path.join(process.env['BACKUP_DIR']!, '.backup.lock')), false)
  })
})

describe('backup validation off the event loop', () => {
  it('validates an uploaded backup through the admin API', async () => {
    setupPaths()
    const created = await createBackup()
    const archive = fs.readFileSync(path.join(process.env['BACKUP_DIR']!, created.filename))
    const app = Fastify({ logger: false })
    await app.register(multipart)
    app.addHook('preHandler', async (request) => { request.user = { userId: 1, email: 'admin@example.test', role: 'admin' } })
    await app.register(backupRoutes, { prefix: '/backups' })
    await app.ready()
    try {
      const valid = await app.inject({ method: 'POST', url: '/backups/validate', ...multipartBody(archive) })
      assert.equal(valid.statusCode, 200, valid.body)
      assert.equal(valid.json().valid, true)
      assert.equal(valid.json().manifest.databaseIntegrity, 'ok')
      assert.equal(valid.json().vaultKeyMatches, true)
      const invalid = await app.inject({ method: 'POST', url: '/backups/validate', ...multipartBody(Buffer.from('not a backup')) })
      assert.equal(invalid.statusCode, 400)
      assert.ok(invalid.json().error)
    } finally { await app.close() }
  })

  it('runs validation on a real worker thread and reports its errors', async () => {
    setupPaths()
    const created = await createBackup()
    const options = {
      workerUrl: new URL('../src/workers/backupWorker.ts', import.meta.url),
      moduleUrl: new URL('../src/services/backup.ts', import.meta.url).href,
      execArgv: ['--import', 'tsx'],
    }
    const manifest = await spawnBackupWorker<BackupManifest>({ task: 'validate', input: path.join(process.env['BACKUP_DIR']!, created.filename) }, options)
    assert.equal(manifest.databaseIntegrity, 'ok')
    const garbage = path.join(temp!, 'garbage.backup')
    fs.writeFileSync(garbage, 'not a backup')
    await assert.rejects(() => spawnBackupWorker({ task: 'validate', input: garbage }, options))
  })
})

describe('restore application check', () => {
  function writeMarker(owner: Record<string, unknown>, ageMs: number): void {
    const marker = path.join(process.env['DATA_DIR']!, '.bsp-running')
    fs.writeFileSync(marker, JSON.stringify(owner))
    const at = new Date(Date.now() - ageMs)
    fs.utimesSync(marker, at, at)
  }

  it('treats a live app with a stalled heartbeat as running', () => {
    setupPaths()
    writeMarker({ pid: process.ppid, processStartedAt: 0 }, 2 * 60_000)
    assert.throws(() => assertAppStopped(), /still running/)
  })

  it('clears the marker of an app that is gone', () => {
    setupPaths()
    writeMarker({ pid: deadPid(), processStartedAt: 0 }, 2 * 60_000)
    assert.doesNotThrow(() => assertAppStopped())
    assert.equal(fs.existsSync(path.join(process.env['DATA_DIR']!, '.bsp-running')), false)
  })

  it('does not let a long-stale marker block restore even if its pid was reused', () => {
    setupPaths()
    writeMarker({ pid: process.ppid, processStartedAt: 0 }, 60 * 60_000)
    assert.doesNotThrow(() => assertAppStopped())
  })
})
