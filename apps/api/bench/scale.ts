/**
 * Scale benchmark: runs the real scheduler, write path and read paths against a throwaway SQLite file.
 *
 *   npm run bench -- --monitors=100 --days=30 --interval=60
 *
 * Nothing here touches the configured database: DATABASE_PATH is pointed at a temp directory.
 */
import http from 'node:http'
import os from 'node:os'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=')
  return [key, value ?? 'true']
}))
const MONITORS = Number(args['monitors'] ?? 100)
const DAYS = Number(args['days'] ?? 30)
const INTERVAL = Number(args['interval'] ?? 60)
const HANG_TIMEOUT_MS = 3_000

const dir = mkdtempSync(join(os.tmpdir(), 'bsp-bench-'))
const dbPath = join(dir, 'bench.sqlite')
process.env['DATABASE_PATH'] = dbPath
// Ctrl+C skips the finally below, so the temporary database is removed here too.
process.once('SIGINT', () => { rmSync(dir, { recursive: true, force: true }); process.exit(130) })

const { initDb, closeDb, db, sqlite } = await import('../src/db/client.js')
const { runMigrations } = await import('../src/db/migrate.js')
const { monitors } = await import('../src/db/schema.js')
const scheduler = await import('../src/workers/scheduler.js')
const { checkHttps } = await import('../src/workers/https.js')
const publicData = await import('../src/services/publicStatusData.js')
const { loadMonitorStats } = await import('../src/services/monitorStats.js')
const { publicRoutes } = await import('../src/routes/public.js')

const section = (title: string) => console.log(`\n## ${title}`)
const ms = (n: number) => Math.round(n * 10) / 10
const sleep = (n: number) => new Promise<void>((resolve) => setTimeout(resolve, n))

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

async function sample(label: string, iterations: number, fn: (i: number) => Promise<unknown>) {
  await fn(0) // warm-up: statement cache, JIT
  const times: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await fn(i)
    times.push(performance.now() - start)
  }
  const result = { label, n: iterations, p50: ms(percentile(times, 0.5)), p95: ms(percentile(times, 0.95)), max: ms(Math.max(...times)) }
  console.log(`${label}: p50 ${result.p50} ms, p95 ${result.p95} ms, max ${result.max} ms (n=${iterations})`)
  return result
}

/** Event-loop delay while `fn` runs: a stall here is a stall for every API request. */
async function withLoopDelay<T>(fn: () => Promise<T>) {
  const histogram = monitorEventLoopDelay({ resolution: 5 })
  histogram.enable()
  const start = performance.now()
  const value = await fn()
  const elapsed = performance.now() - start
  histogram.disable()
  return { value, elapsed, loopP99: ms(histogram.percentile(99) / 1e6), loopMax: ms(histogram.max / 1e6) }
}

// Deterministic pseudo-random so two runs seed the same data.
function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mb = (bytes: number) => ms(bytes / 1024 / 1024)

// A failed check makes the run exit with 1, so the benchmark doubles as a regression test for the scheduler and the database.
let failures = 0
function verify(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

/** Every monitor has exactly one result since `from`, with the status the scenario expects. */
function verifyTick(label: string, from: number, expected: (monitorId: number) => string) {
  const rows = sqlite.prepare(
    'SELECT monitor_id AS id, count(*) AS n, min(status) AS status FROM monitor_results WHERE checked_at >= ? GROUP BY monitor_id',
  ).all(from) as Array<{ id: number; n: number; status: string }>
  verify(`${label}: every monitor checked`, rows.length === MONITORS, `${rows.length} of ${MONITORS}`)
  verify(`${label}: exactly one result each`, rows.every((row) => row.n === 1), `${rows.filter((row) => row.n !== 1).length} monitors differ`)
  verify(`${label}: expected statuses`, rows.every((row) => row.status === expected(row.id)), `${rows.filter((row) => row.status !== expected(row.id)).length} monitors differ`)
}

async function main() {
  initDb()
  runMigrations()

  // Local target: /ok answers after 20 ms, /hang never answers (the check times out).
  const sockets = new Set<import('node:net').Socket>()
  const target = http.createServer((req, res) => {
    if (req.url === '/hang') return
    setTimeout(() => res.end('ok'), 20)
  })
  target.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`

  console.log(`# Benchmark: ${MONITORS} monitors, ${DAYS} days of history, ${INTERVAL}s interval`)
  console.log(`node ${process.version}, ${os.cpus()[0]?.model.trim()} x${os.cpus().length}, ${mb(os.totalmem() / 1)} MB RAM, ${process.platform}`)

  const now = Date.now()
  const insertMonitor = sqlite.prepare(
    'INSERT INTO monitors (name, key, type, interval_secs, timeout_ms, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (let i = 0; i < MONITORS; i++) {
    insertMonitor.run(`Monitor ${i + 1}`, `monitor-${i + 1}`, 'https', INTERVAL, 10_000, JSON.stringify({ url: `${base}/ok` }), now, now)
  }

  // The public API only mentions monitors placed on the page, so put every monitor on it.
  const tree = { id: 'root', type: 'page', children: Array.from({ length: MONITORS }, (_, i) => ({ id: `n${i + 1}`, type: 'monitor', monitorId: i + 1 })) }
  sqlite.prepare('INSERT INTO layout (id, tree, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(tree), now)

  section('Seed')
  const insertResult = sqlite.prepare(
    'INSERT INTO monitor_results (monitor_id, status, response_ms, checked_at, error_message, unconfirmed) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const seedStart = performance.now()
  const perMonitor = Math.floor((DAYS * 86_400) / INTERVAL)
  let seeded = 0
  for (let id = 1; id <= MONITORS; id++) {
    const random = rng(id)
    sqlite.exec('BEGIN')
    for (let n = perMonitor; n > 0; n--) {
      const roll = random()
      const status = roll < 0.995 ? 'up' : roll < 0.998 ? 'degraded' : 'down'
      insertResult.run(id, status, status === 'down' ? null : Math.round(40 + random() * 300), now - n * INTERVAL * 1000, status === 'down' ? 'connect ECONNREFUSED' : null, 0)
      seeded++
    }
    sqlite.exec('COMMIT')
  }
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const seedMs = performance.now() - seedStart
  const dbMb = mb(statSync(dbPath).size)
  console.log(`${seeded.toLocaleString('en')} result rows in ${ms(seedMs / 1000)} s (${Math.round(seeded / (seedMs / 1000)).toLocaleString('en')} rows/s), database ${dbMb} MB`)

  section('Scheduler tick: all monitors due, real HTTP checks against a local 20 ms endpoint')
  const healthyFrom = Date.now()
  const healthy = await withLoopDelay(() => scheduler.runSchedulerTick())
  console.log(`tick ${ms(healthy.elapsed)} ms for ${MONITORS} checks; event loop p99 ${healthy.loopP99} ms, max ${healthy.loopMax} ms`)
  verifyTick('healthy tick', healthyFrom, () => 'up')

  section(`Scheduler tick: 10% of monitors hang until their ${HANG_TIMEOUT_MS} ms timeout`)
  // Every 10th monitor hangs. They are spread across all chunks, which is the realistic case: nobody sorts monitors by health.
  for (let id = 1; id <= MONITORS; id++) {
    const hangs = id % 10 === 0
    sqlite.prepare('UPDATE monitors SET config = ?, timeout_ms = ?, last_checked_at = NULL WHERE id = ?')
      .run(JSON.stringify({ url: `${base}${hangs ? '/hang' : '/ok'}` }), hangs ? HANG_TIMEOUT_MS : 10_000, id)
  }
  const concurrency = 20
  const hangFrom = Date.now()
  const chunked = await withLoopDelay(() => scheduler.runSchedulerTick(undefined, { ...baseConfig(), checkConcurrency: concurrency }))
  console.log(`scheduler (pool of ${concurrency}): tick ${ms(chunked.elapsed)} ms`)
  verifyTick('tick with hanging monitors', hangFrom, (id) => (id % 10 === 0 ? 'down' : 'up'))
  verify('hanging monitors fail with their timeout', (sqlite.prepare(
    `SELECT count(*) AS n FROM monitor_results WHERE checked_at >= ? AND status = 'down' AND error_message NOT LIKE '%Timed out%'`,
  ).get(hangFrom) as { n: number }).n === 0)

  // Same workload through a worker pool, to size the head-of-line cost without touching the scheduler.
  async function pooledTick(items: Array<{ id: number; timeoutMs: number }>, limit: number) {
    let next = 0
    const start = performance.now()
    await Promise.all(Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const item = items[next++]!
        await sleep(item.id % 10 === 0 ? item.timeoutMs : 20)
      }
    }))
    return performance.now() - start
  }
  const modelItems = Array.from({ length: MONITORS }, (_, i) => ({ id: i + 1, timeoutMs: HANG_TIMEOUT_MS }))
  const modelChunked = await (async () => {
    const start = performance.now()
    for (let i = 0; i < modelItems.length; i += concurrency) {
      await Promise.all(modelItems.slice(i, i + concurrency).map((item) => sleep(item.id % 10 === 0 ? item.timeoutMs : 20)))
    }
    return performance.now() - start
  })()
  const modelPooled = await pooledTick(modelItems, concurrency)
  console.log(`model of the former chunked scheduler, same latencies: chunks ${ms(modelChunked)} ms vs worker pool ${ms(modelPooled)} ms (limit ${concurrency})`)

  section('Overlapping ticks: hanging checks keep earlier ticks alive')
  // Half of the monitors are due now and hang; the other half become due while the first tick still runs. A limit that
  // applied per tick would let both ticks run their checks at once.
  const overlapTimeout = 1_000
  const half = Math.floor(MONITORS / 2)
  sqlite.prepare('UPDATE monitors SET config = ?, timeout_ms = ?, last_checked_at = ?')
    .run(JSON.stringify({ url: `${base}/hang` }), overlapTimeout, Date.now())
  sqlite.prepare('UPDATE monitors SET last_checked_at = NULL WHERE id <= ?').run(half)
  // The real HTTP checker and write path, with a counter around them: exact, unlike counting connections at the target.
  let running = 0
  let peak = 0
  const measuredRun = async (monitor: typeof monitors.$inferSelect) => {
    running++
    peak = Math.max(peak, running)
    try {
      await scheduler.recordObservation(monitor, await checkHttps(JSON.parse(monitor.config), monitor.timeoutMs))
    } finally {
      running--
    }
  }
  const overlapFrom = Date.now()
  const overlapStart = performance.now()
  const firstTick = scheduler.runSchedulerTick(measuredRun, { ...baseConfig(), checkConcurrency: concurrency })
  await sleep(300)
  sqlite.prepare('UPDATE monitors SET last_checked_at = NULL WHERE id > ?').run(half)
  await Promise.all([firstTick, scheduler.runSchedulerTick(measuredRun, { ...baseConfig(), checkConcurrency: concurrency })])
  console.log(`${MONITORS} hanging checks over two ticks: ${ms(performance.now() - overlapStart)} ms, at most ${peak} at once (limit ${concurrency}, ideal ${Math.ceil(MONITORS / concurrency) * overlapTimeout} ms)`)
  verify('overlapping ticks: never more checks at once than the limit', peak <= concurrency, `${peak} > ${concurrency}`)
  verifyTick('overlapping ticks', overlapFrom, () => 'down')

  section('Write path: recordObservation (insert result + update monitor + alert evaluation)')
  const all = await db.select().from(monitors)
  for (const monitor of all) await scheduler.recordObservation(monitor, { status: 'up', responseMs: 50, error: null }) // warm-up
  const rounds = 20
  const writes = await withLoopDelay(async () => {
    for (let r = 0; r < rounds; r++) {
      for (const monitor of all) await scheduler.recordObservation(monitor, { status: 'up', responseMs: 50, error: null })
    }
  })
  const observations = rounds * all.length
  console.log(`synchronous=FULL (default): ${observations} observations in ${ms(writes.elapsed)} ms, ${ms(writes.elapsed / observations)} ms each, ${Math.round(observations / (writes.elapsed / 1000))} per second`)
  // A steady state of N monitors at INTERVAL seconds needs N / INTERVAL observations per second.
  console.log(`required at steady state: ${ms(MONITORS / INTERVAL)} per second`)
  sqlite.exec('PRAGMA synchronous = NORMAL')
  const relaxed = await withLoopDelay(async () => {
    for (let r = 0; r < rounds; r++) {
      for (const monitor of all) await scheduler.recordObservation(monitor, { status: 'up', responseMs: 50, error: null })
    }
  })
  sqlite.exec('PRAGMA synchronous = FULL')
  console.log(`synchronous=NORMAL (experiment): ${ms(relaxed.elapsed / observations)} ms each, ${Math.round(observations / (relaxed.elapsed / 1000))} per second`)

  section(`Read paths over ${seeded.toLocaleString('en')} rows`)
  const ids = all.map((monitor) => monitor.id)
  await sample('public status (all monitors)', 50, () => publicData.loadPublicStatus())
  await sample('uptime 90d, one monitor', 100, (i) => publicData.loadUptime(ids[i % ids.length]!, 90))
  const pageStart = performance.now()
  for (const id of ids) await publicData.loadUptime(id, 90)
  console.log(`uptime 90d, every monitor once (uncached page view): ${ms(performance.now() - pageStart)} ms`)
  await sample('history 24h, 60 buckets', 100, (i) => publicData.loadHistory(ids[i % ids.length]!, 24, 60))
  await sample('history 7d, 60 buckets', 50, (i) => publicData.loadHistory(ids[i % ids.length]!, 168, 60))
  await sample('admin stats 24h', 50, (i) => loadMonitorStats(ids[i % ids.length]!, 24, 90))
  await sample('admin stats 7d', 50, (i) => loadMonitorStats(ids[i % ids.length]!, 168, 90))
  await sample(`admin stats ${Math.min(DAYS, 30)}d`, 20, (i) => loadMonitorStats(ids[i % ids.length]!, Math.min(DAYS, 30) * 24, 90))

  section('HTTP: public status page API under load (real sockets, 32 concurrent clients, 5 s each)')
  const app = Fastify({ logger: false })
  await app.register(publicRoutes, { prefix: '/api/v1/public' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const apiBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1/public`
  for (const [label, path] of [
    ['GET /status', () => '/status'],
    ['GET /monitor/:id/uptime?days=90', (i: number) => `/monitor/${ids[i % ids.length]}/uptime?days=90`],
    ['GET /monitor/:id/history?hours=24', (i: number) => `/monitor/${ids[i % ids.length]}/history?hours=24&buckets=60`],
  ] as const) {
    const latencies: number[] = []
    let counter = 0
    let failed = 0
    const deadline = performance.now() + 5_000
    await Promise.all(Array.from({ length: 32 }, async () => {
      while (performance.now() < deadline) {
        const start = performance.now()
        const response = await fetch(apiBase + path(counter++))
        await response.arrayBuffer()
        if (!response.ok) failed++
        latencies.push(performance.now() - start)
      }
    }))
    console.log(`${label}: ${Math.round(latencies.length / 5)} req/s, p50 ${ms(percentile(latencies, 0.5))} ms, p99 ${ms(percentile(latencies, 0.99))} ms${failed ? `, ${failed} non-2xx` : ''}`)
  }
  await app.close()

  section('Retention purge')
  const purgeStart = performance.now()
  const before = (sqlite.prepare('SELECT count(*) AS n FROM monitor_results').get() as { n: number }).n
  await scheduler.purgeOldResults(Date.now(), { ...baseConfig(), resultRetentionDays: DAYS - 1 })
  const after = (sqlite.prepare('SELECT count(*) AS n FROM monitor_results').get() as { n: number }).n
  console.log(`deleted ${(before - after).toLocaleString('en')} rows in ${ms(performance.now() - purgeStart)} ms`)

  section('Integrity')
  verify('integrity_check', (sqlite.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check === 'ok')
  verify('foreign_key_check', sqlite.prepare('PRAGMA foreign_key_check').all().length === 0)
  verify('every monitor shows the status of its latest result', (sqlite.prepare(
    'SELECT count(*) AS n FROM monitors m WHERE m.current_status != (SELECT r.status FROM monitor_results r WHERE r.monitor_id = m.id ORDER BY r.id DESC LIMIT 1)',
  ).get() as { n: number }).n === 0)
  verify('no check left in flight', ids.every((id) => !scheduler.isCheckInFlight(id)))

  console.log(`\nprocess RSS at the end: ${mb(process.memoryUsage().rss)} MB`)
  for (const socket of sockets) socket.destroy()
  target.close()
}

function baseConfig() {
  return { tickCron: '*/10 * * * * *', resultPurgeCron: '0 2 * * *', resultRetentionDays: 90, checkConcurrency: 20 }
}

try {
  await main()
} finally {
  closeDb()
  // --keep leaves the database behind for experiments with queries and indexes.
  if (args['keep']) console.log(`database kept at ${dbPath}`)
  else rmSync(dir, { recursive: true, force: true })
}
process.exit(failures > 0 ? 1 : 0)
