import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { closeDb, initDb, sqlite } from '../src/db/client.js'
import { BACKUP_FORMAT_VERSION, createBackup, validateBackup, type BackupManifest } from '../src/services/backup.js'
import { createArchive } from '../src/services/backupArchive.js'
import { restoreBackup } from '../src/services/restore.js'
import { createTestDb, initTestDb, teardownTestDb, type TestDb } from './helpers/testDb.js'

const VAULT_KEY = 'c'.repeat(64)
let testDb: TestDb
let temp = ''

function manifestFor(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: Date.now(),
    appVersion: 'test',
    databaseIntegrity: 'ok',
    requiresVaultKey: true,
    vaultKeyFingerprint: crypto.createHash('sha256').update(VAULT_KEY).digest('hex'),
    files: { database: true, setup: false, uploads: 0 },
    ...overrides,
  }
}

/** Builds a backup archive from raw parts, so each test can break exactly one thing. */
function craftBackup(name: string, parts: { manifest?: unknown; database?: string | Buffer | null; extra?: Record<string, string> }): string {
  const dir = fs.mkdtempSync(path.join(temp, 'parts-'))
  const entries: Array<{ name: string; source: string }> = []
  if (parts.manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), typeof parts.manifest === 'string' ? parts.manifest : JSON.stringify(parts.manifest))
    entries.push({ name: 'manifest.json', source: path.join(dir, 'manifest.json') })
  }
  if (parts.database !== null && parts.database !== undefined) {
    const file = path.join(dir, 'database.sqlite')
    if (typeof parts.database === 'string') fs.copyFileSync(parts.database, file)
    else fs.writeFileSync(file, parts.database)
    entries.push({ name: 'database.sqlite', source: file })
  }
  for (const [entryName, content] of Object.entries(parts.extra ?? {})) {
    const file = path.join(dir, entryName.replaceAll('/', '_'))
    fs.writeFileSync(file, content)
    entries.push({ name: entryName, source: file })
  }
  const output = path.join(temp, name)
  createArchive(output, entries)
  return output
}

function sqliteFile(name: string, sql: string): string {
  const file = path.join(temp, name)
  const handle = new DatabaseSync(file)
  handle.exec(sql)
  handle.close()
  return file
}

function currentEmail(): string {
  const handle = new DatabaseSync(process.env['DATABASE_PATH']!, { readOnly: true })
  try { return (handle.prepare('SELECT email FROM users').get() as { email: string }).email }
  finally { handle.close() }
}

beforeEach(() => {
  testDb = createTestDb('bsp-restore-test-', 'db.sqlite')
  temp = testDb.dir
  process.env['DATA_DIR'] = temp
  process.env['UPLOAD_DIR'] = path.join(temp, 'uploads')
  process.env['SETUP_CONFIG_PATH'] = path.join(temp, 'setup.json')
  process.env['BACKUP_DIR'] = path.join(temp, 'backups')
  process.env['VAULT_ENCRYPTION_KEY'] = VAULT_KEY
  initTestDb()
  sqlite.exec("INSERT INTO users(email,password_hash,role,created_at) VALUES ('live@example.test','hash','admin',1)")
  closeDb()
})

afterEach(() => {
  teardownTestDb(testDb)
})

describe('restore rejects unusable backups before touching data', () => {
  it('requires a 64-character hexadecimal vault key', async () => {
    const archive = craftBackup('any.backup', { manifest: manifestFor(), database: process.env['DATABASE_PATH']! })
    for (const key of ['', 'c'.repeat(63), 'z'.repeat(64)]) {
      await assert.rejects(() => restoreBackup(archive, { vaultEncryptionKey: key }), /exactly 64 hexadecimal characters/)
    }
    assert.equal(currentEmail(), 'live@example.test')
  })

  it('rejects files that are not backups, truncated or tampered with', async () => {
    const notBackup = path.join(temp, 'random.backup')
    fs.writeFileSync(notBackup, 'PK\u0003\u0004 definitely a zip file')
    await assert.rejects(() => restoreBackup(notBackup, { vaultEncryptionKey: VAULT_KEY }), /Unsupported backup format/)

    const valid = craftBackup('valid.backup', { manifest: manifestFor(), database: process.env['DATABASE_PATH']! })
    const bytes = fs.readFileSync(valid)
    const truncated = path.join(temp, 'truncated.backup')
    fs.writeFileSync(truncated, bytes.subarray(0, bytes.length - 100))
    await assert.rejects(() => restoreBackup(truncated, { vaultEncryptionKey: VAULT_KEY }), /Truncated backup archive|Unexpected end/)

    const tampered = path.join(temp, 'tampered.backup')
    const flipped = Buffer.from(bytes)
    flipped[flipped.length - 50]! ^= 0xff
    fs.writeFileSync(tampered, flipped)
    await assert.rejects(() => restoreBackup(tampered, { vaultEncryptionKey: VAULT_KEY }), /Checksum mismatch: database\.sqlite/)

    assert.equal(currentEmail(), 'live@example.test')
  })

  it('rejects archives missing the manifest or the database', async () => {
    const noDb = craftBackup('no-db.backup', { manifest: manifestFor(), database: null })
    await assert.rejects(() => restoreBackup(noDb, { vaultEncryptionKey: VAULT_KEY }), /missing required files/)
    const noManifest = craftBackup('no-manifest.backup', { database: process.env['DATABASE_PATH']! })
    await assert.rejects(() => restoreBackup(noManifest, { vaultEncryptionKey: VAULT_KEY }), /missing required files/)
    assert.equal(currentEmail(), 'live@example.test')
  })

  it('rejects an unsupported format version or unreadable manifest', async () => {
    const future = craftBackup('future.backup', { manifest: manifestFor({ formatVersion: 99 }), database: process.env['DATABASE_PATH']! })
    await assert.rejects(() => restoreBackup(future, { vaultEncryptionKey: VAULT_KEY }), /Unsupported backup version: 99/)
    const garbled = craftBackup('garbled.backup', { manifest: '{not json', database: process.env['DATABASE_PATH']! })
    await assert.rejects(() => restoreBackup(garbled, { vaultEncryptionKey: VAULT_KEY }), SyntaxError)
    assert.equal(currentEmail(), 'live@example.test')
  })

  it('rejects a database file that is not SQLite', async () => {
    const archive = craftBackup('bad-db.backup', { manifest: manifestFor(), database: Buffer.from('this is not a sqlite database'.repeat(200)) })
    await assert.rejects(() => restoreBackup(archive, { vaultEncryptionKey: VAULT_KEY }))
    assert.equal(currentEmail(), 'live@example.test')
  })

  // The integrity check must close its handle even when `prepare` throws; otherwise Windows fails the
  // temp-dir cleanup with EPERM, hiding the real "file is not a database" error.
  it('explains that the database is not SQLite', async () => {
    const archive = craftBackup('bad-db-message.backup', { manifest: manifestFor(), database: Buffer.from('this is not a sqlite database'.repeat(200)) })
    await assert.rejects(() => restoreBackup(archive, { vaultEncryptionKey: VAULT_KEY }), /not a database|integrity/i)
  })

  it('rejects a backup made without a vault key fingerprint', async () => {
    const archive = craftBackup('no-fp.backup', { manifest: manifestFor({ vaultKeyFingerprint: null }), database: process.env['DATABASE_PATH']! })
    await assert.rejects(() => restoreBackup(archive, { vaultEncryptionKey: VAULT_KEY }), /does not match/)
    assert.equal(currentEmail(), 'live@example.test')
  })

  it('refuses unsafe entry names inside the archive', async () => {
    // createArchive refuses to write them, so splice a traversal name into a valid archive by hand.
    const archive = craftBackup('traversal.backup', { manifest: manifestFor(), database: process.env['DATABASE_PATH']!, extra: { 'uploads/aaaaaaa': 'x' } })
    const bytes = fs.readFileSync(archive)
    const at = bytes.indexOf(Buffer.from('uploads/aaaaaaa'))
    Buffer.from('../../../evil.').copy(bytes, at)
    fs.writeFileSync(archive, bytes)
    await assert.rejects(() => restoreBackup(archive, { vaultEncryptionKey: VAULT_KEY }), /Unsafe archive path/)
    assert.equal(fs.existsSync(path.join(temp, '..', 'evil.')), false)
  })
})

describe('restore rollback', () => {
  it('puts the previous database, setup and uploads back when migrating the restored copy fails', async () => {
    fs.writeFileSync(process.env['SETUP_CONFIG_PATH']!, '{"setupComplete":true,"marker":"live"}')
    fs.mkdirSync(process.env['UPLOAD_DIR']!, { recursive: true })
    fs.writeFileSync(path.join(process.env['UPLOAD_DIR']!, 'logo.png'), 'live-logo')

    // Passes the integrity check, but the migrations cannot index a table missing its columns.
    const incompatible = sqliteFile('incompatible.sqlite', 'CREATE TABLE monitor_results (id INTEGER PRIMARY KEY);')
    const archive = craftBackup('incompatible.backup', {
      manifest: manifestFor({ files: { database: true, setup: true, uploads: 1 } }),
      database: incompatible,
      extra: { 'setup.json': '{"setupComplete":true,"marker":"restored"}', 'uploads/logo.png': 'restored-logo' },
    })
    assert.equal(validateBackup(archive).databaseIntegrity, 'ok')

    await assert.rejects(() => restoreBackup(archive, { vaultEncryptionKey: VAULT_KEY }))

    assert.equal(currentEmail(), 'live@example.test')
    assert.match(fs.readFileSync(process.env['SETUP_CONFIG_PATH']!, 'utf8'), /"marker":"live"/)
    assert.equal(fs.readFileSync(path.join(process.env['UPLOAD_DIR']!, 'logo.png'), 'utf8'), 'live-logo')
    assert.equal(fs.existsSync(`${process.env['DATABASE_PATH']!}.restore-incoming`), false)
    // The safety backup taken before the attempt is kept for manual recovery.
    assert.equal(fs.readdirSync(process.env['BACKUP_DIR']!).filter((f) => f.endsWith('.backup')).length, 1)
  })

  it('removes setup and uploads that did not exist before a failed restore', async () => {
    const incompatible = sqliteFile('incompatible2.sqlite', 'CREATE TABLE monitor_results (id INTEGER PRIMARY KEY);')
    const archive = craftBackup('incompatible2.backup', {
      manifest: manifestFor({ files: { database: true, setup: true, uploads: 1 } }),
      database: incompatible,
      extra: { 'setup.json': '{"marker":"restored"}', 'uploads/logo.png': 'restored-logo' },
    })

    await assert.rejects(() => restoreBackup(archive, { vaultEncryptionKey: VAULT_KEY }))

    assert.equal(currentEmail(), 'live@example.test')
    assert.equal(fs.existsSync(process.env['SETUP_CONFIG_PATH']!), false)
    assert.equal(fs.existsSync(process.env['UPLOAD_DIR']!), false)
  })

  it('restores into an empty data directory without a safety backup', async () => {
    initDb()
    const created = await createBackup()
    closeDb()
    const archive = path.join(process.env['BACKUP_DIR']!, created.filename)
    const moved = path.join(temp, 'kept.backup')
    fs.renameSync(archive, moved)
    fs.rmSync(process.env['DATABASE_PATH']!, { force: true })
    fs.rmSync(`${process.env['DATABASE_PATH']!}-wal`, { force: true })
    fs.rmSync(`${process.env['DATABASE_PATH']!}-shm`, { force: true })

    const result = await restoreBackup(moved, { vaultEncryptionKey: VAULT_KEY })

    assert.equal(result.safetyBackup, null)
    assert.equal(currentEmail(), 'live@example.test')
    assert.ok(fs.existsSync(process.env['UPLOAD_DIR']!))
  })
})
