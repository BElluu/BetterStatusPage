import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db, sqlite } from '../src/db/client.js'
import { monitorResults, monitors } from '../src/db/schema.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { reportRoutes } from '../src/routes/reports.js'
import { loadUptime } from '../src/services/publicStatusData.js'
import type { MonitorStats, UptimeReport } from '@bsp/shared'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

// The readers take their numbers from the daily totals. This compares them with an independent count made here, in
// JavaScript, from the results that are in the database at that moment.

const DAY = 86_400_000
const testDb = createTestDb('bsp-daily-readers-test-')
const app = Fastify({ logger: false })
const now = Date.now()
const today = Math.floor(now / DAY)

interface Row { monitor_id: number; checked_at: number; status: string; response_ms: number | null; unconfirmed: number }
interface Day { total: number; up: number; maintenance: number; responseSum: number; responseCount: number }

/** What a day's results add up to, by the rules of the status page, from the results as they are now. */
function oracle(monitorId: number): Map<number, Day> {
  const days = new Map<number, Day>()
  const rows = sqlite.prepare('SELECT * FROM monitor_results WHERE monitor_id = ?').all(monitorId) as unknown as Row[]
  for (const row of rows) {
    const day = Math.floor(row.checked_at / DAY)
    const entry = days.get(day) ?? { total: 0, up: 0, maintenance: 0, responseSum: 0, responseCount: 0 }
    if (row.unconfirmed === 2) entry.maintenance++
    else {
      entry.total++
      if (row.status === 'up' || row.unconfirmed === 1) entry.up++
    }
    if (row.response_ms !== null) { entry.responseSum += row.response_ms; entry.responseCount++ }
    days.set(day, entry)
  }
  return days
}

function random(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ids: Record<string, number> = {}

before(async () => {
  initTestDb()
  const created = Date.now()
  for (const name of ['Alpha', 'Beta', 'Empty']) {
    ids[name] = (await db.insert(monitors).values({ name, type: 'https', config: '{}', createdAt: created, updatedAt: created }).returning())[0]!.id
  }
  const rows: Array<typeof monitorResults.$inferInsert> = []
  const statuses = ['up', 'up', 'up', 'down', 'degraded', 'affected']
  for (const [name, span, seed] of [['Alpha', 70, 1], ['Beta', 12, 2]] as const) {
    const next = random(seed)
    for (let back = 0; back < span; back++) {
      const dayStart = (today - back) * DAY
      const latest = back === 0 ? now - dayStart : DAY - 1
      if (back === 6 && name === 'Alpha') continue // a day with no check at all
      const count = back === 0 ? 3 : 1 + Math.floor(next() * 6)
      for (let i = 0; i < count; i++) {
        const maintenanceOnly = name === 'Alpha' && back === 5
        rows.push({
          monitorId: ids[name]!,
          checkedAt: dayStart + (i === 0 ? 0 : Math.min(latest, Math.floor(next() * DAY))),
          status: maintenanceOnly ? 'down' : statuses[Math.floor(next() * statuses.length)]!,
          responseMs: next() < 0.2 ? null : Math.floor(next() * 500),
          unconfirmed: maintenanceOnly ? 2 : next() < 0.1 ? 1 : next() < 0.1 ? 2 : 0,
        })
      }
      if (back > 0 && !(name === 'Alpha' && back === 5)) rows.push({ monitorId: ids[name]!, checkedAt: dayStart + DAY - 1, status: 'up', responseMs: 7, unconfirmed: 0 }) // last millisecond
    }
  }
  await db.insert(monitorResults).values(rows)
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(reportRoutes, { prefix: '/reports' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10)

describe('readers of the daily totals', () => {
  for (const name of ['Alpha', 'Beta', 'Empty']) {
    it(`status page uptime of ${name} matches the results, day by day`, async () => {
      const expected = oracle(ids[name]!)
      for (const span of [7, 30, 90]) {
        const { days, overallUptimePct } = await loadUptime(ids[name]!, span)
        assert.equal(days.length, span)
        let total = 0
        let up = 0
        for (const shown of days) {
          const day = Math.floor(Date.parse(shown.date + 'T00:00:00.000Z') / DAY)
          const want = expected.get(day) ?? { total: 0, up: 0, maintenance: 0 }
          assert.deepEqual([shown.checksTotal, shown.checksUp, shown.maintenanceChecks], [want.total, want.up, want.maintenance], `${name} ${shown.date}`)
          total += want.total
          up += want.up
        }
        assert.equal(overallUptimePct, total > 0 ? (up / total) * 100 : null)
      }
    })
  }

  it('shows a day with only maintenance as maintenance, and a day without checks as no data', async () => {
    const { days } = await loadUptime(ids['Alpha']!, 30)
    const byDate = new Map(days.map((d) => [d.date, d]))
    const onlyMaintenance = byDate.get(isoDay(today - 5))!
    assert.equal(onlyMaintenance.checksTotal, 0)
    assert.ok(onlyMaintenance.maintenanceChecks > 0)
    assert.equal(onlyMaintenance.status, 'maintenance')
    const empty = byDate.get(isoDay(today - 6))!
    assert.deepEqual([empty.checksTotal, empty.maintenanceChecks], [0, 0])
    assert.notEqual(empty.status, 'maintenance')
  })

  it('report of a range matches the results, per monitor', async () => {
    const response = await app.inject({ method: 'GET', url: `/reports/uptime?from=${isoDay(today - 60)}&to=${isoDay(today)}` })
    const report = response.json() as UptimeReport
    assert.equal(report.monitors.length, 3)
    for (const monitor of report.monitors) {
      let total = 0
      let up = 0
      let sum = 0
      let count = 0
      for (const [day, d] of oracle(monitor.monitorId)) {
        if (day < today - 60 || day > today) continue
        total += d.total; up += d.up; sum += d.responseSum; count += d.responseCount
      }
      assert.deepEqual([monitor.checksTotal, monitor.checksUp], [total, up], monitor.monitorName)
      assert.equal(monitor.uptimePct, total > 0 ? (up / total) * 100 : null)
      assert.equal(monitor.avgResponseMs, count > 0 ? sum / count : null)
    }
  })

  it('daily CSV of the report matches the results, gaps included', async () => {
    const from = today - 10
    const csv = (await app.inject({ method: 'GET', url: `/reports/uptime/export?granularity=day&monitorId=${ids['Alpha']}&from=${isoDay(from)}&to=${isoDay(today)}` })).body
    const lines = csv.trim().split(/\r?\n/).slice(1).map((line) => line.replace(/"/g, '').split(','))
    const expected = oracle(ids['Alpha']!)
    assert.equal(lines.length, 11)
    for (const [, , date, total, up] of lines) {
      const want = expected.get(Math.floor(Date.parse(date! + 'T00:00:00.000Z') / DAY)) ?? { total: 0, up: 0 }
      assert.deepEqual([Number(total), Number(up)], [want.total, want.up], String(date))
    }
  })

  it('daily bars of the monitor statistics match the results', async () => {
    const stats = (await app.inject({ method: 'GET', url: `/monitors/${ids['Alpha']}/stats?hours=2160` })).json() as MonitorStats
    assert.equal(stats.uptime.stepHours, 24)
    const expected = oracle(ids['Alpha']!)
    assert.equal(stats.uptime.bars.length, 90)
    for (const bar of stats.uptime.bars) {
      const want = expected.get(bar.ts / DAY) ?? { total: 0, up: 0, maintenance: 0 }
      assert.deepEqual([bar.checksTotal, bar.checksUp, bar.maintenanceChecks], [want.total, want.up, want.maintenance], isoDay(bar.ts / DAY))
    }
  })

  it('keeps matching after retention takes a day away and cuts another in half', async () => {
    const cut = (today - 20) * DAY + DAY / 2
    sqlite.prepare('DELETE FROM monitor_results WHERE checked_at < ?').run(cut) // what retention does
    const expected = oracle(ids['Alpha']!)
    const { days } = await loadUptime(ids['Alpha']!, 90)
    for (const shown of days) {
      const want = expected.get(Math.floor(Date.parse(shown.date + 'T00:00:00.000Z') / DAY)) ?? { total: 0 }
      assert.equal(shown.checksTotal, want.total, shown.date)
    }
    assert.ok(days.filter((d) => d.checksTotal > 0).length <= 21)
  })
})
