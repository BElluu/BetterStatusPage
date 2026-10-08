import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db } from '../src/db/client.js'
import { incidentMonitors, incidents, monitorResults, monitors } from '../src/db/schema.js'
import { reportRoutes } from '../src/routes/reports.js'
import type { UptimeReport } from '@bsp/shared'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-reports-test-')
const app = Fastify({ logger: false })
const DAY = 86_400_000
const at = (day: string, hour = 12) => Date.parse(`${day}T00:00:00.000Z`) + hour * 3_600_000

let alpha = 0
let beta = 0

async function addResults(monitorId: number, rows: Array<{ day: string; status: string; responseMs?: number; unconfirmed?: number }>) {
  await db.insert(monitorResults).values(rows.map((row, index) => ({
    monitorId, status: row.status, responseMs: row.responseMs ?? null, checkedAt: at(row.day, index % 20),
    unconfirmed: row.unconfirmed ?? 0,
  })))
}

before(async () => {
  initTestDb()
  const now = Date.now()
  const base = { type: 'https', config: '{}', createdAt: now, updatedAt: now }
  alpha = (await db.insert(monitors).values({ ...base, name: 'Alpha' }).returning())[0]!.id
  beta = (await db.insert(monitors).values({ ...base, name: '=Beta' }).returning())[0]!.id

  await addResults(alpha, [
    { day: '2026-03-01', status: 'up', responseMs: 100 },
    { day: '2026-03-01', status: 'up', responseMs: 200 },
    { day: '2026-03-01', status: 'down' },
    { day: '2026-03-01', status: 'down', unconfirmed: 1 }, // does not lower uptime
    { day: '2026-03-03', status: 'up', responseMs: 300 },
    { day: '2026-02-28', status: 'down' }, // before the range
    { day: '2026-03-04', status: 'down' }, // after the range
  ])
  await addResults(beta, [{ day: '2026-03-02', status: 'down' }])

  const [incident] = await db.insert(incidents).values({
    title: 'Outage', status: 'resolved', impact: 'major', startedAt: at('2026-03-02'), resolvedAt: at('2026-03-02', 14), createdAt: now, updatedAt: now,
  }).returning()
  await db.insert(incidentMonitors).values({ incidentId: incident!.id, monitorId: alpha })
  const [older] = await db.insert(incidents).values({
    title: 'Old', status: 'resolved', impact: 'minor', startedAt: at('2026-01-01'), resolvedAt: at('2026-01-01', 2), createdAt: now, updatedAt: now,
  }).returning()
  await db.insert(incidentMonitors).values({ incidentId: older!.id, monitorId: alpha })

  await app.register(reportRoutes, { prefix: '/reports' })
  await app.ready()
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

describe('uptime report', () => {
  it('sums results per monitor over the inclusive UTC day range', async () => {
    const response = await app.inject({ method: 'GET', url: '/reports/uptime?from=2026-03-01&to=2026-03-03' })
    assert.equal(response.statusCode, 200, response.body)
    const report = response.json<UptimeReport>()
    assert.equal(report.from, '2026-03-01')
    assert.equal(report.to, '2026-03-03')
    assert.equal(report.retentionDays, 90)
    assert.deepEqual(report.monitors.map((m) => m.monitorName), ['=Beta', 'Alpha'])

    const a = report.monitors.find((m) => m.monitorId === alpha)!
    assert.equal(a.checksTotal, 5)
    assert.equal(a.checksUp, 4)
    assert.equal(a.uptimePct, 80)
    assert.equal(a.avgResponseMs, 200)
    assert.equal(a.incidents, 1, 'only the incident overlapping the range counts')
    assert.equal('days' in a, false)

    const b = report.monitors.find((m) => m.monitorId === beta)!
    assert.equal(b.uptimePct, 0)
    assert.equal(b.avgResponseMs, null)
    assert.equal(b.incidents, 0)
  })

  it('reports no uptime for a range without results and filters by monitor', async () => {
    const empty = (await app.inject({ method: 'GET', url: `/reports/uptime?from=2026-04-01&to=2026-04-02&monitorId=${alpha}` })).json<UptimeReport>()
    assert.equal(empty.monitors.length, 1)
    assert.equal(empty.monitors[0]!.uptimePct, null)
    assert.equal(empty.monitors[0]!.checksTotal, 0)
  })

  it('validates the range and the monitor', async () => {
    for (const query of [
      'from=2026-03-05&to=2026-03-01', 'from=nope', 'to=2026-02-30', 'from=2024-01-01&to=2026-03-01', 'monitorId=abc', 'monitorId=0',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/reports/uptime?${query}` })
      assert.equal(response.statusCode, 400, query)
    }
    const defaults = (await app.inject({ method: 'GET', url: '/reports/uptime' })).json<UptimeReport>()
    assert.equal((Date.parse(defaults.to) - Date.parse(defaults.from)) / DAY, 29)
  })

  it('exports one CSV row per monitor and day, gaps and formula-looking names included', async () => {
    const response = await app.inject({ method: 'GET', url: `/reports/uptime/export?from=2026-03-01&to=2026-03-03&monitorId=${alpha}` })
    assert.equal(response.statusCode, 200)
    assert.match(String(response.headers['content-type']), /text\/csv/)
    assert.match(String(response.headers['content-disposition']), /attachment; filename="uptime-daily-2026-03-01-2026-03-03\.csv"/)
    assert.deepEqual(response.body.trim().split('\r\n'), [
      'monitor_id,monitor,date,checks_total,checks_up,uptime_pct',
      `"${alpha}","Alpha","2026-03-01","4","3","75.000"`,
      `"${alpha}","Alpha","2026-03-02","0","0",""`,
      `"${alpha}","Alpha","2026-03-03","1","1","100.000"`,
    ])

    const all = (await app.inject({ method: 'GET', url: '/reports/uptime/export?from=2026-03-02&to=2026-03-02' })).body
    assert.ok(all.includes(`"${beta}","'=Beta"`), 'formula-looking monitor name is neutralised')
  })

  it('exports a summary CSV with one row per monitor', async () => {
    const response = await app.inject({ method: 'GET', url: '/reports/uptime/export?from=2026-03-01&to=2026-03-03&granularity=total' })
    assert.equal(response.statusCode, 200)
    assert.match(String(response.headers['content-disposition']), /uptime-summary-/)
    const lines = response.body.trim().split('\r\n')
    assert.equal(lines[0], 'monitor_id,monitor,from,to,checks_total,checks_up,uptime_pct,avg_response_ms,incidents')
    assert.equal(lines.length, 3)
    assert.equal(lines[2], `"${alpha}","Alpha","2026-03-01","2026-03-03","5","4","80.000","200","1"`)

    assert.equal((await app.inject({ method: 'GET', url: '/reports/uptime/export?granularity=week' })).statusCode, 400)
  })
})
