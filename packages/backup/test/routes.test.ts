import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { auditDbModule, createAudit } from '@better-kit/audit'
import { openDatabase, runMigrations, type Database } from '@better-kit/db'
import {
  createBackupRoutes, createBackupScheduler, createBackupService, DEFAULT_BACKUP_CONFIG, scheduleExpression, type BackupManifest,
} from '@better-kit/backup'
import { DatabaseSync } from 'node:sqlite'

let dir: string
let audit: Database<Record<string, unknown>>
let app: FastifyInstance
let restarted: number

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-backup-routes-'))
  audit = openDatabase({ path: ':memory:', schema: auditDbModule.tables })
  runMigrations(audit.sqlite, [auditDbModule], { log: () => undefined })
  restarted = 0
  const sqlite = new DatabaseSync(path.join(dir, 'app.sqlite'))
  sqlite.exec('CREATE TABLE t (x)')
  sqlite.close()
  const service = createBackupService<BackupManifest>({
    name: 'kit', magic: 'KITBKP01', formatVersion: 1,
    backupDir: () => path.join(dir, 'backups'), databasePath: () => path.join(dir, 'app.sqlite'), appVersion: () => '1',
    processOwner: { current: () => ({ pid: process.pid, processStartedAt: 1 }), isAlive: () => false },
    extras: () => ({ entries: [], manifest: {} }),
  })
  app = Fastify({ logger: false })
  await app.register(createBackupRoutes({
    service,
    audit: createAudit({ db: audit.db }),
    identity: () => ({ userId: 1, email: 'admin@example.test' }),
    createBackup: () => service.createBackup(),
    validateBackup: async (input) => service.validateBackup(input),
    restartScheduler: () => { restarted++ },
  }), { prefix: '/backups' })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  audit.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('backup routes', () => {
  it('lists nothing at first, creates a backup and offers it for download', async () => {
    assert.deepEqual((await app.inject('/backups')).json().backups, [])
    const created = await app.inject({ method: 'POST', url: '/backups' })
    assert.equal(created.statusCode, 200)
    const { filename } = created.json()
    assert.equal((await app.inject('/backups')).json().backups[0].filename, filename)
    const download = await app.inject(`/backups/${filename}/download`)
    assert.equal(download.headers['content-disposition'], `attachment; filename="${filename}"`)
    assert.equal(download.rawPayload.subarray(0, 8).toString(), 'KITBKP01')
    // A copy of the whole database leaving the server is on record, with who took it.
    const downloads = audit.sqlite.prepare("select user_email, entity_name from audit_log where action = 'allow' and entity_type = 'backup'").all()
    assert.deepEqual(downloads.map((row) => ({ ...row })), [{ user_email: 'admin@example.test', entity_name: filename }])
    assert.equal((await app.inject('/backups/kit-backup-1.backup/download')).statusCode, 404)
    assert.equal((await app.inject('/backups/..%2Fx/download')).statusCode, 400)
  })

  it('answers 409 with the reason when a backup cannot be made', async () => {
    fs.writeFileSync(path.join(dir, 'app.sqlite'), 'not a database')
    const response = await app.inject({ method: 'POST', url: '/backups' })
    assert.equal(response.statusCode, 409)
    assert.ok(response.json().error)
  })

  it('validates the schedule, saves it and applies it', async () => {
    const put = (body: object) => app.inject({ method: 'PUT', url: '/backups/config', payload: body })
    for (const [body, message] of [
      [{ frequency: 'hourly' }, /Invalid frequency/], [{ hour: 24 }, /Hour/], [{ minute: -1 }, /Minute/], [{ weekday: 7 }, /Weekday/], [{ retention: 0 }, /Retention/],
    ] as const) {
      const response = await put(body)
      assert.equal(response.statusCode, 400)
      assert.match(response.json().error, message)
    }
    assert.equal(restarted, 0)
    const saved = await put({ enabled: true, frequency: 'weekly', hour: 3, weekday: 2, retention: 5 })
    assert.equal(saved.statusCode, 200)
    assert.deepEqual(saved.json(), { ...DEFAULT_BACKUP_CONFIG, enabled: true, frequency: 'weekly', hour: 3, weekday: 2, retention: 5 })
    assert.equal(restarted, 1)
    assert.equal((await app.inject('/backups')).json().config.retention, 5)
  })

  it('deletes a backup only when its exact name is typed', async () => {
    const { filename } = (await app.inject({ method: 'POST', url: '/backups' })).json()
    assert.equal((await app.inject({ method: 'DELETE', url: `/backups/${filename}` })).statusCode, 400)
    assert.equal((await app.inject({ method: 'DELETE', url: `/backups/${filename}?confirm=${filename}` })).statusCode, 204)
    assert.equal((await app.inject({ method: 'DELETE', url: `/backups/${filename}?confirm=${filename}` })).statusCode, 404)
  })
})

describe('scheduler', () => {
  it('writes the cron expression of a daily and a weekly schedule', () => {
    assert.equal(scheduleExpression({ ...DEFAULT_BACKUP_CONFIG, hour: 4, minute: 30 }), '30 4 * * *')
    assert.equal(scheduleExpression({ ...DEFAULT_BACKUP_CONFIG, frequency: 'weekly', hour: 4, minute: 30, weekday: 6 }), '30 4 * * 6')
  })

  it('starts only when enabled, and can be stopped and restarted', () => {
    const log = mock.method(console, 'log', () => undefined)
    let enabled = false
    const scheduler = createBackupScheduler({ readConfig: () => ({ ...DEFAULT_BACKUP_CONFIG, enabled }), run: async () => undefined, logPrefix: '[kit]' })
    try {
      scheduler.restart()
      assert.equal(log.mock.callCount(), 0)
      enabled = true
      scheduler.restart()
      assert.deepEqual(log.mock.calls[0]!.arguments, ['[kit] Scheduler started: 0 2 * * *'])
      scheduler.restart()
      assert.equal(log.mock.callCount(), 2)
    } finally {
      scheduler.stop()
      log.mock.restore()
    }
  })
})
