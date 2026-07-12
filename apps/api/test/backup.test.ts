import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { closeDb, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { createBackup, currentVaultKeyMatches, listBackups, validateBackup } from '../src/services/backup.js'
import { restoreBackup } from '../src/services/restore.js'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { backupRoutes } from '../src/routes/backups.js'
import { createArchive } from '../src/services/backupArchive.js'
import { acquireAppLock } from '../src/services/appLock.js'

let temp: string | null = null
const VAULT_KEY = 'a'.repeat(64)
function setupPaths() {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-backup-test-'))
  process.env['DATA_DIR'] = temp
  process.env['DATABASE_PATH'] = path.join(temp, 'db.sqlite')
  process.env['UPLOAD_DIR'] = path.join(temp, 'uploads')
  process.env['SETUP_CONFIG_PATH'] = path.join(temp, 'setup.json')
  process.env['BACKUP_DIR'] = path.join(temp, 'backups')
  process.env['VAULT_ENCRYPTION_KEY'] = VAULT_KEY
  initDb()
  runMigrations()
}

afterEach(() => {
  closeDb()
  if (temp) fs.rmSync(temp, { recursive: true, force: true })
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
    assert.equal(manifest.appVersion, '0.1.0')
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
