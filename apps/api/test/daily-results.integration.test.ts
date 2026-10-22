import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, it } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { runMigrations as migrate } from '@better-kit/db'
import { closeDb, db, initDb, sqlite } from '../src/db/client.js'
import { findDailyResultsMismatches, rebuildDailyResults } from '../src/db/dailyResults.js'
import { runMigrations } from '../src/db/migrate.js'
import { dbModules } from '../src/db/modules/index.js'
import { monitorDailyResults, monitorResults, monitors } from '../src/db/schema.js'
import { countedChecks, countedUp, maintenanceChecks } from '../src/services/uptimeCounts.js'
import { purgeOldResults, recordObservation } from '../src/workers/scheduler.js'
import type { SchedulerConfig } from '../src/config/scheduler.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const DAY = 86_400_000
const BASE = Math.floor(Date.UTC(2026, 5, 10) / DAY) * DAY // midnight UTC
const GOLDEN = fileURLToPath(new URL('./fixtures/schema-0.4.0.json', import.meta.url))
const MIGRATION = 'monitor-daily-results-v1'

const testDb = createTestDb('bsp-daily-results-test-')
before(() => initTestDb())
after(() => teardownTestDb(testDb))

async function addMonitor(name: string, overrides: Partial<typeof monitors.$inferInsert> = {}) {
  const now = Date.now()
  return (await db.insert(monitors).values({
    name, type: 'webhook', config: '{}', createdAt: now, updatedAt: now, ...overrides,
  }).returning())[0]!
}

type Row = { status?: string; responseMs?: number | null; unconfirmed?: number }
const result = (monitorId: number, checkedAt: number, row: Row = {}): typeof monitorResults.$inferInsert =>
  ({ monitorId, checkedAt, status: row.status ?? 'up', responseMs: row.responseMs === undefined ? 100 : row.responseMs, unconfirmed: row.unconfirmed ?? 0 })

const daily = (monitorId: number) => db.select().from(monitorDailyResults).where(eq(monitorDailyResults.monitorId, monitorId)).orderBy(monitorDailyResults.day)
const day = (n: number) => BASE / DAY + n
const assertConsistent = () => assert.deepEqual(findDailyResultsMismatches(sqlite), [])
const config = (resultRetentionDays: number): SchedulerConfig =>
  ({ tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays, checkConcurrency: 5 })

describe('daily results kept by triggers', () => {
  beforeEach(async () => { await db.delete(monitors) }) // the results and the daily rows follow by cascade

  it('counts every kind of result on its UTC day', async () => {
    const m = await addMonitor('A')
    await db.insert(monitorResults).values([
      result(m.id, BASE + 1000, { responseMs: 100 }),
      result(m.id, BASE + 2000, { status: 'down', responseMs: null }),
      result(m.id, BASE + 3000, { status: 'down', responseMs: null, unconfirmed: 1 }), // unconfirmed: counted as up
      result(m.id, BASE + 4000, { status: 'degraded', responseMs: 300 }),
      result(m.id, BASE + 5000, { status: 'affected', responseMs: 50 }),
      result(m.id, BASE + 6000, { status: 'down', responseMs: 70, unconfirmed: 2 }), // maintenance: in neither total
      result(m.id, BASE + DAY - 1), // last millisecond of the day
      result(m.id, BASE + DAY), // first millisecond of the next
    ])

    assert.deepEqual(await daily(m.id), [
      { monitorId: m.id, day: day(0), checksTotal: 6, checksUp: 3, maintenanceChecks: 1, responseSum: 620, responseCount: 5 },
      { monitorId: m.id, day: day(1), checksTotal: 1, checksUp: 1, maintenanceChecks: 0, responseSum: 100, responseCount: 1 },
    ])
    assertConsistent()
  })

  it('counts exactly as the aggregate of services/uptimeCounts.ts, for every combination', async () => {
    const m = await addMonitor('Parity')
    const rows: Array<typeof monitorResults.$inferInsert> = []
    let t = BASE
    for (const status of ['up', 'down', 'degraded', 'affected', 'pending'])
      for (const unconfirmed of [0, 1, 2])
        for (const responseMs of [null, 0, 250]) for (const dayOffset of [0, 1, 5]) rows.push(result(m.id, BASE + dayOffset * DAY + (t++ % 1000), { status, unconfirmed, responseMs }))
    await db.insert(monitorResults).values(rows)

    const raw = await db.select({
      day: sql<number>`${monitorResults.checkedAt} / ${sql.raw(String(DAY))}`,
      total: countedChecks, up: countedUp, maintenance: maintenanceChecks,
    }).from(monitorResults).groupBy(sql`${monitorResults.checkedAt} / ${sql.raw(String(DAY))}`)
    const expected = raw.map((r) => ({ day: Number(r.day), total: Number(r.total), up: Number(r.up), maintenance: Number(r.maintenance) }))
    const actual = (await daily(m.id)).map((r) => ({ day: r.day, total: r.checksTotal, up: r.checksUp, maintenance: r.maintenanceChecks }))
    assert.deepEqual(actual, expected.sort((a, b) => a.day - b.day))
    assertConsistent()
  })

  it('follows a failure streak that is confirmed later, on the days it lowers', async () => {
    const m = await addMonitor('Flaky', { failureThreshold: 3, currentStatus: 'up', alertConfirmedStatus: 'up' })
    // Two unconfirmed failures late on the previous day, as the scheduler would have left them.
    await db.insert(monitorResults).values([
      result(m.id, BASE - 2000, { status: 'down', responseMs: null, unconfirmed: 1 }),
      result(m.id, BASE - 1000, { status: 'down', responseMs: null, unconfirmed: 1 }),
    ])
    assert.equal((await daily(m.id))[0]!.checksUp, 2)
    const current = (await db.select().from(monitors).where(eq(monitors.id, m.id)))[0]!
    await db.update(monitors).set({ alertPendingStatus: 'down', alertPendingCount: 2 }).where(eq(monitors.id, m.id))

    // The third failure (today) confirms the outage and flips the two before it.
    await recordObservation({ ...current, alertPendingStatus: 'down', alertPendingCount: 2 }, { status: 'down', responseMs: null, error: 'boom' })

    const days = await daily(m.id)
    assert.equal(days.length, 2)
    assert.equal(days[0]!.checksTotal, 2)
    assert.equal(days[0]!.checksUp, 0, 'the earlier day lost its two "up" checks')
    assertConsistent()
  })

  it('follows a result whose status, mark, response time or monitor changes', async () => {
    const a = await addMonitor('A')
    const b = await addMonitor('B')
    const [row] = await db.insert(monitorResults).values(result(a.id, BASE + 10, { status: 'down', responseMs: null })).returning()
    await db.update(monitorResults).set({ status: 'up', responseMs: 80 }).where(eq(monitorResults.id, row!.id))
    assert.deepEqual((await daily(a.id)).map((r) => [r.checksUp, r.responseSum, r.responseCount]), [[1, 80, 1]])
    await db.update(monitorResults).set({ unconfirmed: 2 }).where(eq(monitorResults.id, row!.id))
    assert.deepEqual((await daily(a.id)).map((r) => [r.checksTotal, r.maintenanceChecks]), [[0, 1]])
    await db.update(monitorResults).set({ monitorId: b.id, checkedAt: BASE + 3 * DAY, unconfirmed: 0 }).where(eq(monitorResults.id, row!.id))
    assert.deepEqual((await daily(b.id)).map((r) => [r.day, r.checksTotal]), [[day(3), 1]])
    assertConsistent()
  })

  it('follows retention, including a day that is only cut in half', async () => {
    const m = await addMonitor('Retained')
    const now = BASE + 10 * DAY + 12 * 3_600_000 // noon, so the cutoff of 3 days lands in the middle of a day
    const cutoff = now - 3 * DAY
    await db.insert(monitorResults).values([
      result(m.id, BASE + 5 * DAY + 1000), // gone, alone on its day
      result(m.id, cutoff - 1000), // gone, shares its day with the next one
      result(m.id, cutoff + 1000), // stays
      result(m.id, now - 1000),
    ])

    await purgeOldResults(now, config(3))

    assert.deepEqual((await daily(m.id)).map((r) => [r.day, r.checksTotal]), [[Math.floor(cutoff / DAY), 1], [Math.floor(now / DAY), 1]])
    assert.equal((await db.select().from(monitorResults)).length, 2)
    assert.equal((await db.select().from(monitorDailyResults)).every((r) => r.checksTotal + r.maintenanceChecks > 0), true, 'no empty day is left')
    assertConsistent()
  })

  it('goes away with its monitor, and leaves the others alone', async () => {
    const gone = await addMonitor('Gone')
    const kept = await addMonitor('Kept')
    await db.insert(monitorResults).values([result(gone.id, BASE + 1), result(gone.id, BASE + DAY), result(kept.id, BASE + 2)])

    await db.delete(monitors).where(eq(monitors.id, gone.id)) // cascades into both tables

    assert.equal((await daily(gone.id)).length, 0)
    assert.deepEqual((await daily(kept.id)).map((r) => r.checksTotal), [1])
    assert.equal((await db.select().from(monitorResults).where(eq(monitorResults.monitorId, gone.id))).length, 0)
    assertConsistent()
  })

  it('stays correct when rows are written by something that does not know the table', async () => {
    const m = await addMonitor('Raw')
    // An older version of the application, a restore script or a person with a SQLite shell.
    sqlite.prepare('INSERT INTO monitor_results (monitor_id, status, response_ms, checked_at) VALUES (?, ?, ?, ?)').run(m.id, 'up', 12, BASE + 1)
    sqlite.prepare('INSERT INTO monitor_results (monitor_id, status, response_ms, checked_at, unconfirmed) VALUES (?, ?, ?, ?, ?)').run(m.id, 'down', null, BASE + 2, 1)
    sqlite.prepare('DELETE FROM monitor_results WHERE monitor_id = ? AND status = ?').run(m.id, 'down')
    assert.deepEqual((await daily(m.id)).map((r) => [r.checksTotal, r.checksUp, r.responseSum]), [[1, 1, 12]])
    assertConsistent()
  })

  it('is detected when the table drifts from the results', async () => {
    const m = await addMonitor('Drift')
    await db.insert(monitorResults).values(result(m.id, BASE + 1))
    sqlite.prepare('UPDATE monitor_daily_results SET checks_total = checks_total + 1').run()
    assert.deepEqual(findDailyResultsMismatches(sqlite).map((x) => x.side), ['results-only', 'rollup-only'])
    rebuildDailyResults(sqlite)
    assertConsistent()
  })
})

describe('migration of an existing database', () => {
  /** The schema as the release before this one left it: the current one without the daily table, its triggers and its record. */
  function oldSchema() {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { objects: Array<{ type: string; name: string; sql: string | null }>; migrations: string[] }
    const own = (name: string) => name === 'monitor_daily_results' || name.startsWith('monitor_results_daily_') || name.startsWith('sqlite_autoindex_monitor_daily_results')
    const create = (type: string) => golden.objects.filter((o) => o.type === type && o.sql && !own(o.name)).forEach((o) => sqlite.exec(o.sql!))
    create('table')
    for (const type of ['index', 'trigger', 'view']) create(type)
    const record = sqlite.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
    for (const name of golden.migrations.filter((n) => n !== MIGRATION)) record.run(name, 1_700_000_000_000)
  }

  it('counts the results already there, drops what belongs to no monitor, and keeps counting', () => {
    closeDb()
    const upgrade = createTestDb('bsp-daily-upgrade-')
    try {
      initDb()
      oldSchema()
      assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'monitor_daily_results'`).get()!['n'], 0)
      const monitorId = Number(sqlite.prepare(`INSERT INTO monitors (name, type, config, created_at, updated_at, key) VALUES ('Old', 'https', '{}', 1, 1, 'old')`).run().lastInsertRowid)
      const insert = sqlite.prepare('INSERT INTO monitor_results (monitor_id, status, response_ms, checked_at, unconfirmed) VALUES (?, ?, ?, ?, ?)')
      for (let i = 0; i < 500; i++) insert.run(monitorId, i % 50 === 0 ? 'down' : 'up', i % 7 === 0 ? null : 100 + i, BASE + (i % 4) * DAY + i, i % 50 === 0 ? (i % 100 === 0 ? 1 : 2) : 0)
      // Written while foreign keys were off: the result of a monitor that is gone.
      sqlite.exec('PRAGMA foreign_keys = OFF')
      insert.run(9999, 'up', 1, BASE, 0)
      sqlite.exec('PRAGMA foreign_keys = ON')

      runMigrations()

      assertConsistent()
      const rows = sqlite.prepare('SELECT * FROM monitor_daily_results').all() as Array<{ monitor_id: number; checks_total: number; maintenance_checks: number }>
      assert.ok(rows.every((r) => r.monitor_id === monitorId), 'the orphan was not counted')
      assert.equal(rows.reduce((sum, r) => sum + r.checks_total + r.maintenance_checks, 0), 500)
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM monitor_results').get()!['n'], 501, 'no result was touched')

      // Starting again changes nothing, and a new result is counted once.
      const before = JSON.stringify(sqlite.prepare('SELECT * FROM monitor_daily_results ORDER BY day').all())
      runMigrations()
      assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM monitor_daily_results ORDER BY day').all()), before)
      insert.run(monitorId, 'up', 5, BASE + 10, 0)
      assertConsistent()
      assert.equal((sqlite.prepare('SELECT sum(checks_total) AS n FROM monitor_daily_results').get() as { n: number }).n, 501 - maintenanceOf(sqlite))
    } finally {
      teardownTestDb(upgrade)
    }
  })

  it('leaves nothing behind when the step fails part-way, and works when it is run again', () => {
    closeDb()
    const failing = createTestDb('bsp-daily-rollback-')
    try {
      initDb()
      oldSchema()
      const monitorId = Number(sqlite.prepare(`INSERT INTO monitors (name, type, config, created_at, updated_at, key) VALUES ('Old', 'https', '{}', 1, 1, 'old')`).run().lastInsertRowid)
      sqlite.prepare('INSERT INTO monitor_results (monitor_id, status, checked_at) VALUES (?, ?, ?)').run(monitorId, 'up', BASE)
      const modules = dbModules.map((module) => module.id !== 'app' ? module : {
        ...module,
        migrations: module.migrations.map((step) => step.kind === 'data' && step.name === MIGRATION
          ? { ...step, run: (s: typeof sqlite) => { rebuildDailyResults(s); throw new Error('disk full') } }
          : step),
      })

      assert.throws(() => migrate(sqlite, modules, { log: () => undefined }), /disk full/)

      const objects = sqlite.prepare(`SELECT name FROM sqlite_master WHERE name = 'monitor_daily_results' OR name LIKE 'monitor_results_daily_%'`).all()
      assert.deepEqual(objects, [], 'table and triggers were rolled back with the step')
      assert.equal(sqlite.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(MIGRATION), undefined, 'the step is not recorded')
      // The application still writes results meanwhile: no trigger points at a table that is not there.
      sqlite.prepare('INSERT INTO monitor_results (monitor_id, status, checked_at) VALUES (?, ?, ?)').run(monitorId, 'up', BASE + 1)

      runMigrations()

      assertConsistent()
      assert.equal((sqlite.prepare('SELECT sum(checks_total) AS n FROM monitor_daily_results').get() as { n: number }).n, 2)
    } finally {
      teardownTestDb(failing)
    }
  })
})

/** Results in a maintenance window, which are in no total. */
function maintenanceOf(handle: typeof sqlite): number {
  return (handle.prepare('SELECT count(*) AS n FROM monitor_results WHERE unconfirmed = 2').get() as { n: number }).n
}
