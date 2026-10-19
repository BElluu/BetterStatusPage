import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { adminStaticMirrorRoutes } from '../src/routes/staticMirror.js'
import { db } from '../src/db/client.js'
import { layout, monitors, staticMirrorRuns, staticMirrorSettings, statusPageAccess, incidents, incidentMonitors } from '../src/db/schema.js'
import { refreshPublishedMonitorIds } from '../src/services/publishedMonitors.js'
import {
  checkStaticMirrorAccess, getAdminStaticMirror, getStaticMirrorSettings, mirrorHealth, runStaticMirror, saveStaticMirrorSettings, StaticMirrorError,
} from '../src/services/staticMirror.js'
import { buildMirrorObjects, buildSnapshot, defaultStatusDist } from '../src/services/staticSnapshot.js'
import { SECRET_MASK } from '../src/services/secretFields.js'
import { saveStatusPageAccess, StatusPageAccessError } from '../src/services/statusPageAccess.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)
const testDb = createTestDb('bsp-static-mirror-test-')

const puts: Array<{ method: string; url: string; body: string }> = []
/** Methods the fake storage refuses, as a key without that right would be. */
const refused = new Set<string>()
let server: Server
let endpoint = ''
const ids: Record<string, number> = {}

const SECRET = 'S3CR3T-ACCESS-KEY'
const valid = (over: Record<string, unknown> = {}) => ({
  enabled: true, endpoint, region: 'auto', bucket: 'status-copy', accessKeyId: 'AKID', secretAccessKey: SECRET,
  intervalSeconds: 60, showBanner: true, ...over,
})

before(async () => {
  initTestDb()
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { puts.push({ method: req.method ?? '', url: req.url ?? '', body }); res.statusCode = refused.has(req.method ?? '') ? 403 : 200; res.end(refused.has(req.method ?? '') ? '<Error><Code>AccessDenied</Code></Error>' : '') })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const now = Date.now()
  const rows = await db.insert(monitors).values(['Website', 'Internal DB'].map((name) => ({
    name, type: 'https', config: '{}', currentStatus: 'up', createdAt: now, updatedAt: now,
  }))).returning()
  for (const row of rows) ids[row.name] = row.id
  await db.insert(layout).values({
    id: 1, updatedAt: now,
    tree: JSON.stringify({ id: 'root', type: 'page', children: [
      { id: 'w', type: 'monitor', monitorId: ids['Website'], showUptimeBar: true },
      { id: 'c', type: 'chart', monitorId: ids['Website'], hours: 24, buckets: 30, aggregation: 'avg' },
    ] }),
  })
  const [incident] = await db.insert(incidents).values({ title: 'Website slow', status: 'investigating', impact: 'minor', startedAt: now, createdAt: now, updatedAt: now }).returning()
  await db.insert(incidentMonitors).values([{ incidentId: incident!.id, monitorId: ids['Website']! }, { incidentId: incident!.id, monitorId: ids['Internal DB']! }])
  await refreshPublishedMonitorIds()
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  teardownTestDb(testDb)
})

describe('static mirror settings', () => {
  it('stores the secret encrypted and only ever reads back the mask', async () => {
    const saved = await saveStaticMirrorSettings(valid({ enabled: false }))
    assert.equal(saved.secretAccessKey, SECRET_MASK)
    const stored = (await db.select().from(staticMirrorSettings))[0]!
    assert.notEqual(stored.secretAccessKey, SECRET)
    assert.ok(!JSON.stringify(await getAdminStaticMirror()).includes(SECRET))
  })

  it('keeps the stored secret when the mask comes back, and clears it for an empty value', async () => {
    const before = (await db.select().from(staticMirrorSettings))[0]!.secretAccessKey
    await saveStaticMirrorSettings(valid({ enabled: false, secretAccessKey: SECRET_MASK, bucket: 'other-bucket' }))
    assert.equal((await db.select().from(staticMirrorSettings))[0]!.secretAccessKey, before)
    await saveStaticMirrorSettings(valid({ enabled: false, secretAccessKey: '' }))
    assert.equal((await getStaticMirrorSettings()).secretAccessKey, '')
  })

  it('refuses what cannot work or is not safe', async () => {
    await assert.rejects(saveStaticMirrorSettings(valid({ bucket: '' })), StaticMirrorError)
    await assert.rejects(saveStaticMirrorSettings(valid({ intervalSeconds: 10 })), /interval/)
    await assert.rejects(saveStaticMirrorSettings(valid({ endpoint: 'ftp://host' })), /http/)
    await assert.rejects(saveStaticMirrorSettings(valid({ endpoint: 'https://user:pw@host' })), /credentials/)
    await db.insert(statusPageAccess).values({ id: 1, private: 1, updatedAt: Date.now() })
    await assert.rejects(saveStaticMirrorSettings(valid()), /private/)
    await db.delete(statusPageAccess).where(eq(statusPageAccess.id, 1))
  })

  it('needs a real region and a lowercase bucket without an endpoint (AWS S3)', async () => {
    await assert.rejects(saveStaticMirrorSettings(valid({ endpoint: '', region: 'auto' })), /region/)
    await assert.rejects(saveStaticMirrorSettings(valid({ endpoint: '', region: 'eu-central-1', bucket: 'Status-Copy' })), /lowercase/)
    await saveStaticMirrorSettings(valid({ enabled: false, endpoint: '', region: 'eu-central-1' }))
  })

  it('keeps the page from being made private while the copy is on', async () => {
    await saveStaticMirrorSettings(valid({ enabled: false }))
    await db.update(staticMirrorSettings).set({ enabled: 1 }).where(eq(staticMirrorSettings.id, 1))
    await assert.rejects(saveStatusPageAccess({ private: true }), (err: Error) => err instanceof StatusPageAccessError && /Static fallback/.test(err.message))
    await db.update(staticMirrorSettings).set({ enabled: 0 }).where(eq(staticMirrorSettings.id, 1))
    assert.equal((await saveStatusPageAccess({ private: true })).private, true)
    await db.delete(statusPageAccess).where(eq(statusPageAccess.id, 1))
  })

  it('shows the banner unless told otherwise, and puts the choice in the snapshot', async () => {
    assert.equal((await saveStaticMirrorSettings(valid({ enabled: false }))).showBanner, true)
    assert.equal((await saveStaticMirrorSettings(valid({ enabled: false, showBanner: false }))).showBanner, false)
    assert.equal((await buildSnapshot(1, { showBanner: false })).showBanner, false)
    assert.equal('showBanner' in (await buildSnapshot(1, { showBanner: true })), false)
    await saveStaticMirrorSettings(valid({ enabled: false }))
  })

  it('reports its health from the last run', () => {
    const settings = { ...valid(), secretAccessKey: SECRET_MASK } as never
    const status = { lastRunAt: 1, lastSuccessAt: 1, lastError: null, lastUploadedFiles: 0, copyFiles: null, copyBytes: null }
    assert.equal(mirrorHealth({ ...(settings as object), enabled: false } as never, status), 'disabled')
    assert.equal(mirrorHealth(settings, { ...status, lastSuccessAt: Date.now() }), 'ok')
    // Switched on, nothing pushed yet: not "up to date".
    assert.equal(mirrorHealth(settings, { ...status, lastSuccessAt: null, lastRunAt: null }), 'pending')
    assert.equal(mirrorHealth(settings, { ...status, lastError: 'boom' }), 'error')
    assert.equal(mirrorHealth(settings, { ...status, lastSuccessAt: Date.now() - 4 * 60_000 }), 'stale')
  })
})

describe('snapshot', () => {
  it('holds what visitors may see and nothing about internal monitors', async () => {
    const snapshot = await buildSnapshot(1_700_000_000_000)
    assert.equal(snapshot.schemaVersion, 1)
    assert.equal(snapshot.generatedAt, 1_700_000_000_000)
    const json = JSON.stringify(snapshot)
    assert.ok(json.includes('Website'))
    assert.ok(!json.includes('Internal DB'))
    assert.deepEqual(Object.keys(snapshot.uptime), [String(ids['Website'])])
    // The response time chart of the layout is answered from the snapshot, for exactly the range it asks for.
    assert.deepEqual(Object.keys(snapshot.history ?? {}), [`${ids['Website']}:24:30`])
    assert.equal(snapshot.history![`${ids['Website']}:24:30`]!.buckets.length, 30)
    const [incident] = snapshot.incidents as Array<{ monitorIds: number[] }>
    assert.deepEqual(incident!.monitorIds, [ids['Website']])
  })

  it('lists the page files before the page, and the snapshot last', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-dist-'))
    fs.mkdirSync(path.join(dist, 'assets'))
    fs.writeFileSync(path.join(dist, 'assets', 'app-abc.js'), 'console.log(1)')
    fs.writeFileSync(path.join(dist, 'index.html'), '<html><head><title>x</title></head><body></body></html>')
    try {
      const objects = buildMirrorObjects(await buildSnapshot(), dist)
      assert.deepEqual(objects.map((o) => o.key), ['assets/app-abc.js', 'index.html', '404.html', 'snapshot.json'])
      const index = objects.find((o) => o.key === 'index.html')!
      assert.match(String(index.body), /<meta name="bsp-snapshot" content="\/snapshot.json" \/>\n {2}<\/head>/)
      assert.equal(index.cacheControl, 'no-cache')
      assert.match(objects[0]!.cacheControl!, /immutable/)
    } finally {
      fs.rmSync(dist, { recursive: true, force: true })
    }
  })

  it('does not read files outside the upload folder for a logo URL', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-dist-'))
    fs.writeFileSync(path.join(dist, 'index.html'), '<html><head></head></html>')
    try {
      const snapshot = await buildSnapshot()
      const evil = { ...snapshot, status: { branding: { logoUrl: '/uploads/../../../../etc/hosts' } }, layout: { branding: null } }
      const keys = buildMirrorObjects(evil, dist).map((o) => o.key)
      assert.ok(!keys.some((key) => key.startsWith('uploads/')))
      // A malformed escape is skipped, it does not fail the run.
      const broken = { ...snapshot, status: { branding: { logoUrl: '/uploads/%E0%A4%A' } }, layout: { branding: null } }
      assert.ok(!buildMirrorObjects(broken, dist).some((o) => o.key.startsWith('uploads/')))
    } finally {
      fs.rmSync(dist, { recursive: true, force: true })
    }
  })
})

describe('checking access', () => {
  it('writes a small object and removes it, without pushing the page', async () => {
    puts.length = 0
    assert.deepEqual(await checkStaticMirrorAccess(valid()), { ok: true, error: null })
    assert.deepEqual(puts.map((p) => p.method), ['PUT', 'DELETE'])
    // One name, so a key that cannot delete leaves a single file that the next check overwrites.
    assert.ok(puts.every((p) => p.url === '/status-copy/.bsp-access-check'))
    assert.ok(!puts.some((p) => p.body.includes(SECRET)))
  })

  it('uses the stored secret when the form sends the mask', async () => {
    await saveStaticMirrorSettings(valid({ enabled: false }))
    puts.length = 0
    assert.equal((await checkStaticMirrorAccess(valid({ secretAccessKey: SECRET_MASK }))).ok, true)
  })

  it('passes for a key that may write but not delete', async () => {
    refused.add('DELETE')
    try {
      assert.equal((await checkStaticMirrorAccess(valid())).ok, true)
    } finally {
      refused.clear()
    }
  })

  it('says what the service refused, without the key', async () => {
    refused.add('PUT')
    try {
      const result = await checkStaticMirrorAccess(valid())
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /HTTP 403 AccessDenied/)
      assert.ok(!(result.error ?? '').includes(SECRET))
    } finally {
      refused.clear()
    }
  })

  it('does not follow a redirect, and does not name the endpoint in the failure', async () => {
    const redirecting = createServer((_req, res) => { res.statusCode = 307; res.setHeader('location', 'http://127.0.0.1:1/elsewhere'); res.end() })
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve))
    try {
      const port = (redirecting.address() as { port: number }).port
      const result = await checkStaticMirrorAccess(valid({ endpoint: `http://127.0.0.1:${port}` }))
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /HTTP 307/)
      assert.ok(!(result.error ?? '').includes(String(port)))
    } finally {
      redirecting.close()
    }
  })

  it('has no stored secret to stand for when the form sends the mask after it was cleared', async () => {
    await saveStaticMirrorSettings(valid({ enabled: false, secretAccessKey: '' }))
    await assert.rejects(checkStaticMirrorAccess(valid({ secretAccessKey: SECRET_MASK })), /Fill in/)
    await saveStaticMirrorSettings(valid({ enabled: false }))
  })

  it('refuses a form that cannot be tried', async () => {
    await assert.rejects(checkStaticMirrorAccess(valid({ bucket: '' })), /Fill in/)
    await assert.rejects(checkStaticMirrorAccess(valid({ secretAccessKey: '' })), /Fill in/)
    await assert.rejects(checkStaticMirrorAccess(valid({ endpoint: '', region: 'auto' })), /region/)
  })

  it('answers 400 over HTTP for a form that cannot be tried', async () => {
    const app = Fastify({ logger: false })
    await app.register(adminStaticMirrorRoutes, { prefix: '/static-mirror' })
    const response = await app.inject({ method: 'POST', url: '/static-mirror/check', payload: valid({ bucket: '' }) })
    assert.equal(response.statusCode, 400)
    await app.close()
  })
})

describe('a push on demand', () => {
  it('is refused while the mirror is off, and does not touch the target', async () => {
    const app = Fastify({ logger: false })
    await app.register(adminStaticMirrorRoutes, { prefix: '/static-mirror' })
    await saveStaticMirrorSettings(valid({ enabled: false }))
    puts.length = 0
    const response = await app.inject({ method: 'POST', url: '/static-mirror/test' })
    assert.equal(response.statusCode, 409)
    assert.match(response.json().error, /off/)
    assert.equal(puts.length, 0)
    await app.close()
  })
})

describe('a mirror run', () => {
  const built = fs.existsSync(path.join(defaultStatusDist, 'index.html'))

  it('uploads signed files to the target and records the success', { skip: !built && 'apps/status is not built' }, async () => {
    puts.length = 0
    await saveStaticMirrorSettings(valid())
    await runStaticMirror()
    const keys = puts.map((p) => p.url)
    assert.ok(keys.every((url) => url.startsWith('/status-copy/')))
    assert.equal(keys.at(-1), '/status-copy/snapshot.json')
    assert.ok(!puts.some((p) => p.body.includes(SECRET)))
    const admin = await getAdminStaticMirror()
    assert.equal(admin.status.lastError, null)
    assert.ok(admin.status.lastSuccessAt)
    assert.equal(admin.health, 'ok')
    // What the copy holds, and the history the page draws its bars from.
    assert.ok((admin.status.copyFiles ?? 0) > 3)
    assert.ok((admin.status.copyBytes ?? 0) > 1000)
    assert.equal(admin.runs.at(-1)?.ok, true)
    assert.equal(admin.runs.at(-1)?.uploadedFiles, keys.length)

    // Nothing changed except the snapshot's timestamp.
    puts.length = 0
    await runStaticMirror()
    assert.deepEqual(puts.map((p) => p.url), ['/status-copy/snapshot.json'])
  })

  it('uploads the whole page again when the settings are saved or a full push is asked for', { skip: !built && 'apps/status is not built' }, async () => {
    await saveStaticMirrorSettings(valid())
    await runStaticMirror()
    puts.length = 0
    await runStaticMirror()
    assert.deepEqual(puts.map((p) => p.url), ['/status-copy/snapshot.json'])

    // The bucket was emptied by hand: what the last push remembered is no longer true.
    await saveStaticMirrorSettings(valid())
    await runStaticMirror()
    assert.ok(puts.some((p) => p.url === '/status-copy/index.html'))

    puts.length = 0
    await runStaticMirror({ full: true })
    assert.ok(puts.some((p) => p.url === '/status-copy/index.html'))
  })

  it('records an error instead of publishing once the page is private', async () => {
    await db.insert(statusPageAccess).values({ id: 1, private: 1, updatedAt: Date.now() })
    puts.length = 0
    await runStaticMirror()
    assert.equal(puts.length, 0)
    const admin = await getAdminStaticMirror()
    assert.match(admin.status.lastError ?? '', /private/)
    assert.equal(admin.health, 'error')
    assert.equal(admin.runs.at(-1)?.ok, false)
    assert.match(admin.runs.at(-1)?.error ?? '', /private/)
    await db.delete(statusPageAccess).where(eq(statusPageAccess.id, 1))
  })
})

describe('the history of pushes', () => {
  it('keeps the newest 48', async () => {
    await db.insert(statusPageAccess).values({ id: 1, private: 1, updatedAt: Date.now() })
    try {
      for (let i = 0; i < 60; i++) await runStaticMirror()
    } finally {
      await db.delete(statusPageAccess).where(eq(statusPageAccess.id, 1))
    }
    const rows = await db.select().from(staticMirrorRuns)
    assert.equal(rows.length, 48)
    assert.equal((await getAdminStaticMirror()).runs.length, 24)
  })
})
