import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  collectFiles, createArchiveFormat, createBackupRunner, createBackupService, createRestore, INTERRUPTED_BACKUP_ERROR,
  type BackupManifest, type RestoreExtras,
} from '@better-kit/backup'

let dir: string

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-backup-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const file = (...parts: string[]) => path.join(dir, ...parts)

function writeDatabase(target: string, rows: string[]): void {
  const sqlite = new DatabaseSync(target)
  sqlite.exec('CREATE TABLE IF NOT EXISTS notes (text TEXT)')
  for (const row of rows) sqlite.prepare('INSERT INTO notes VALUES (?)').run(row)
  sqlite.close()
}

function readNotes(source: string): string[] {
  const sqlite = new DatabaseSync(source, { readOnly: true })
  try { return (sqlite.prepare('SELECT text FROM notes ORDER BY rowid').all() as Array<{ text: string }>).map((row) => row.text) }
  finally { sqlite.close() }
}

interface Manifest extends BackupManifest { note: string }

function serviceFor(owner = { alive: true }, name = 'kit') {
  fs.mkdirSync(file('data'), { recursive: true })
  return createBackupService<Manifest>({
    name, magic: 'KITBKP01', formatVersion: 1,
    backupDir: () => file('backups'),
    databasePath: () => file('data', 'app.sqlite'),
    appVersion: () => '1.2.3',
    processOwner: { current: () => ({ pid: process.pid, processStartedAt: 1 }), isAlive: () => owner.alive },
    extras: () => ({ entries: collectFiles(file('data', 'files'), 'files'), manifest: { note: 'hello' } }),
  })
}

describe('archive format', () => {
  const format = createArchiveFormat({ magic: 'KITTEST1' })

  it('round-trips files below a directory and refuses another product’s archive', () => {
    fs.mkdirSync(file('src', 'sub'), { recursive: true })
    fs.writeFileSync(file('src', 'a.txt'), 'alpha')
    fs.writeFileSync(file('src', 'sub', 'b.txt'), 'beta')
    format.createArchive(file('x.archive'), collectFiles(file('src'), 'files'))
    assert.deepEqual(format.extractArchive(file('x.archive'), file('out')).sort(), ['files/a.txt', 'files/sub/b.txt'])
    assert.equal(fs.readFileSync(file('out', 'files', 'sub', 'b.txt'), 'utf8'), 'beta')
    assert.throws(() => createArchiveFormat({ magic: 'OTHER001' }).extractArchive(file('x.archive'), file('out2')), /Unsupported backup format/)
  })

  it('detects a changed byte and a truncated archive', () => {
    fs.writeFileSync(file('a.txt'), 'alpha')
    format.createArchive(file('x.archive'), [{ name: 'a.txt', source: file('a.txt') }])
    const bytes = fs.readFileSync(file('x.archive'))
    const flipped = Buffer.from(bytes)
    const at = flipped.indexOf('alpha')
    flipped[at] = flipped[at]! ^ 1
    fs.writeFileSync(file('flipped.archive'), flipped)
    fs.writeFileSync(file('short.archive'), bytes.subarray(0, bytes.length - 8))
    assert.throws(() => format.extractArchive(file('flipped.archive'), file('o1')), /Checksum mismatch: a.txt/)
    assert.throws(() => format.extractArchive(file('short.archive'), file('o2')), /Unexpected end of backup archive|Truncated backup archive/)
  })

  it('refuses names that would leave the destination', () => {
    fs.writeFileSync(file('a.txt'), 'alpha')
    for (const name of ['../escape', '/abs', 'a/../b']) {
      assert.throws(() => format.createArchive(file('bad.archive'), [{ name, source: file('a.txt') }]), /Unsafe archive path/)
      fs.rmSync(file('bad.archive'), { force: true })
    }
  })
})

describe('backup service', () => {
  it('takes a product name literally: a dot in it does not match any other character', () => {
    const service = serviceFor({ alive: true }, 'my.app')
    assert.equal(path.basename(service.backupFile('my.app-backup-1.backup')), 'my.app-backup-1.backup')
    assert.throws(() => service.backupFile('myxapp-backup-1.backup'), /Invalid backup filename/)
  })

  it('writes the database, the extra files and a manifest with the application’s fields in order', async () => {
    const service = serviceFor()
    writeDatabase(file('data', 'app.sqlite'), ['one'])
    fs.mkdirSync(file('data', 'files'))
    fs.writeFileSync(file('data', 'files', 'logo.png'), 'png')

    const info = await service.createBackup()
    assert.match(info.filename, /^kit-backup-\d+\.backup$/)
    const manifest = service.validateBackup(path.join(file('backups'), info.filename))
    assert.deepEqual(Object.keys(manifest), ['formatVersion', 'createdAt', 'appVersion', 'databaseIntegrity', 'note'])
    assert.equal(manifest.appVersion, '1.2.3')
    const extracted = service.extractArchive(path.join(file('backups'), info.filename), file('out'))
    assert.deepEqual(extracted.sort(), ['database.sqlite', 'files/logo.png', 'manifest.json'])
    assert.deepEqual(readNotes(file('out', 'database.sqlite')), ['one'])
    assert.deepEqual(service.readBackupStatus().state, 'success')
    assert.equal(fs.existsSync(file('backups', '.backup.lock')), false)
  })

  it('refuses a backup of another version or without its database, and a file that is not a backup', async () => {
    const service = serviceFor()
    const other = createBackupService<Manifest>({ ...{ name: 'kit', magic: 'KITBKP01' }, formatVersion: 2,
      backupDir: () => file('backups'), databasePath: () => file('data', 'app.sqlite'), appVersion: () => '1',
      processOwner: { current: () => ({ pid: 1, processStartedAt: 1 }), isAlive: () => false }, extras: () => ({ entries: [], manifest: { note: '' } }) })
    writeDatabase(file('data', 'app.sqlite'), [])
    const info = await other.createBackup()
    assert.throws(() => service.validateBackup(path.join(file('backups'), info.filename)), /Unsupported backup version: 2/)

    const format = createArchiveFormat({ magic: 'KITBKP01' })
    fs.writeFileSync(file('only.txt'), 'x')
    format.createArchive(file('empty.backup'), [{ name: 'only.txt', source: file('only.txt') }])
    assert.throws(() => service.validateBackup(file('empty.backup')), /missing required files/)
    fs.writeFileSync(file('junk.backup'), 'not a backup')
    assert.throws(() => service.validateBackup(file('junk.backup')))
  })

  it('records a failure, leaves no partial file and releases the lock', async () => {
    const service = serviceFor()
    fs.writeFileSync(file('data', 'app.sqlite'), 'this is not a database')
    await assert.rejects(() => service.createBackup())
    assert.equal(service.readBackupStatus().state, 'error')
    assert.deepEqual(fs.readdirSync(file('backups')).filter((name) => name.endsWith('.partial')), [])
    assert.equal(service.isBackupLockHeld(), false)
  })

  it('keeps two backups apart and reads a dead owner’s lock as free', async () => {
    const owner = { alive: true }
    const service = serviceFor(owner)
    writeDatabase(file('data', 'app.sqlite'), [])
    fs.mkdirSync(file('backups'), { recursive: true })
    fs.writeFileSync(file('backups', '.backup.lock'), JSON.stringify({ pid: 99, processStartedAt: 1, startedAt: Date.now() }))
    assert.equal(service.isBackupLockHeld(), true)
    await assert.rejects(() => service.createBackup(), /Another backup operation is already running/)
    fs.writeFileSync(file('backups', 'status.json'), JSON.stringify({ state: 'running' }))
    assert.equal(service.readBackupStatus().state, 'running')

    owner.alive = false
    assert.equal(service.isBackupLockHeld(), false)
    assert.deepEqual([service.readBackupStatus().state, service.readBackupStatus().lastError], ['error', INTERRUPTED_BACKUP_ERROR])
    await service.createBackup()
  })

  it('lists newest first, keeps the newest ones on retention and refuses foreign filenames', async () => {
    const service = serviceFor()
    fs.mkdirSync(file('backups'), { recursive: true })
    for (const [index, name] of ['kit-backup-1.backup', 'kit-backup-2.backup', 'kit-backup-3.backup'].entries()) {
      fs.writeFileSync(file('backups', name), 'x')
      fs.utimesSync(file('backups', name), 1000 + index, 1000 + index)
    }
    fs.writeFileSync(file('backups', 'unrelated.txt'), 'x')
    assert.deepEqual(service.listBackups().map((item) => item.filename), ['kit-backup-3.backup', 'kit-backup-2.backup', 'kit-backup-1.backup'])
    service.applyRetention(0)
    assert.deepEqual(service.listBackups().map((item) => item.filename), ['kit-backup-3.backup'])
    assert.throws(() => service.backupFile('../kit-backup-1.backup'), /Invalid backup filename/)
    assert.throws(() => service.backupFile('other-backup-1.backup'), /Invalid backup filename/)
  })

  it('stores the schedule with defaults for what is missing', () => {
    const service = serviceFor()
    assert.equal(service.readBackupConfig().retention, 7)
    service.writeBackupConfig({ ...service.readBackupConfig(), enabled: true, retention: 3 })
    assert.deepEqual([service.readBackupConfig().enabled, service.readBackupConfig().retention], [true, 3])
  })
})

describe('restore', () => {
  function setup(extras: Partial<RestoreExtras> = {}, migrate: () => void = () => undefined) {
    const service = serviceFor({ alive: false })
    const events: string[] = []
    const restore = createRestore<Manifest>({
      service, name: 'kit', displayName: 'Kit', databasePath: () => file('data', 'app.sqlite'),
      assertStopped: () => events.push('stopped'),
      database: { open: () => events.push('open'), close: () => events.push('close'), migrate },
      extras: () => ({
        save: () => events.push('save'), apply: () => events.push('apply'), rollback: () => events.push('rollback'), ...extras,
      }),
    })
    return { service, restore, events }
  }

  it('replaces the database, takes a safety backup first and lets the application refuse the backup', async () => {
    const { service, restore, events } = setup()
    writeDatabase(file('data', 'app.sqlite'), ['old'])
    const made = await service.createBackup()
    writeDatabase(file('data', 'app.sqlite'), ['newer'])

    await assert.rejects(() => restore(path.join(file('backups'), made.filename), { check: () => { throw new Error('wrong key') } }), /wrong key/)
    assert.deepEqual(readNotes(file('data', 'app.sqlite')), ['old', 'newer'])

    events.length = 0
    const result = await restore(path.join(file('backups'), made.filename), { prepare: () => events.push('prepare') })
    assert.deepEqual(readNotes(file('data', 'app.sqlite')), ['old'])
    assert.match(result.safetyBackup ?? '', /^kit-backup-\d+\.backup$/)
    assert.deepEqual(events, ['stopped', 'prepare', 'open', 'close', 'save', 'apply', 'open', 'close'])
  })

  it('puts everything back when the restored database cannot be migrated', async () => {
    const { service, restore, events } = setup({}, () => { throw new Error('migration failed') })
    writeDatabase(file('data', 'app.sqlite'), ['old'])
    const made = await service.createBackup()
    writeDatabase(file('data', 'app.sqlite'), ['newer'])
    events.length = 0
    await assert.rejects(() => restore(path.join(file('backups'), made.filename)), /migration failed/)
    assert.deepEqual(readNotes(file('data', 'app.sqlite')), ['old', 'newer'])
    assert.ok(events.includes('rollback'))
  })

  it('refuses to restore a backup it cannot verify, before touching anything', async () => {
    const { restore, events } = setup()
    writeDatabase(file('data', 'app.sqlite'), ['keep'])
    fs.writeFileSync(file('junk.backup'), 'junk')
    await assert.rejects(() => restore(file('junk.backup')))
    assert.deepEqual(readNotes(file('data', 'app.sqlite')), ['keep'])
    assert.deepEqual(events, ['stopped'])
  })

  it('does not restore while the database is in use, and names the application', async () => {
    const { service, restore } = setup()
    writeDatabase(file('data', 'app.sqlite'), ['old'])
    const made = await service.createBackup()
    const holder = new DatabaseSync(file('data', 'app.sqlite'))
    holder.exec('BEGIN EXCLUSIVE')
    try {
      await assert.rejects(() => restore(path.join(file('backups'), made.filename)), /Database is in use\. Stop Kit before restoring\./)
    } finally { holder.exec('ROLLBACK'); holder.close() }
  })
})

describe('runner', () => {
  it('runs the work in the calling thread when asked to', async () => {
    const service = serviceFor()
    writeDatabase(file('data', 'app.sqlite'), [])
    const runner = createBackupRunner({ service, inline: true, workerUrl: new URL('file:///unused.js'), moduleUrl: 'file:///unused.js' })
    const info = await runner.createBackup()
    assert.equal((await runner.validateBackup(path.join(file('backups'), info.filename))).note, 'hello')
  })
})
