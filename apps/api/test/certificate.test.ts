import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import type { HttpsConfig } from '@bsp/shared'
import { db } from '../src/db/client.js'
import { monitorNotificationChannels, monitors, notificationChannels, notificationDeliveries, notificationDeliveryAttempts } from '../src/db/schema.js'
import {
  CERT_CHECK_INTERVAL_MS, CERT_RETRY_INTERVAL_MS, certificateTarget, certMilestone, checkCertificateExpiry,
  normalizeCertExpiry, readCertificate, type CertificateReader,
} from '../src/workers/certificate.js'
import { expiresInPhrase } from '../src/workers/notifier.js'
import { certificateStep } from '../src/workers/testRunner.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const DAY = 24 * 60 * 60 * 1000
const testDb = createTestDb('bsp-certificate-test-')
const requests: Array<{ url: string; body: string }> = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    requests.push({ url: request.url ?? '', body: Buffer.concat(chunks).toString() })
    response.writeHead(204).end()
  })
})
let baseUrl = ''

before(async () => {
  initTestDb()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(async () => {
  await db.delete(notificationDeliveryAttempts)
  await db.delete(notificationDeliveries)
  await db.delete(monitorNotificationChannels)
  await db.delete(notificationChannels)
  await db.delete(monitors)
  requests.length = 0
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  teardownTestDb(testDb)
})

const httpsConfig = (certExpiry?: HttpsConfig['certExpiry']): HttpsConfig => ({
  url: 'https://status.example.test/health', method: 'GET', expectedStatus: 200, ...(certExpiry ? { certExpiry } : {}),
})

async function createMonitor(config: HttpsConfig, channelTypes: Array<'discord' | 'teams' | 'slack'> = ['discord']) {
  const now = Date.now()
  const [monitor] = await db.insert(monitors).values({
    name: 'Checkout', type: 'https', intervalSecs: 60, timeoutMs: 1_000, config: JSON.stringify(config),
    currentStatus: 'up', createdAt: now, updatedAt: now,
  }).returning()
  for (const type of channelTypes) {
    const [channel] = await db.insert(notificationChannels).values({
      name: type, type, config: JSON.stringify({ webhookUrl: `${baseUrl}/${type}` }), enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })
  }
  return monitor!
}

async function reload(id: number) {
  return (await db.select().from(monitors).where(eq(monitors.id, id)))[0]!
}

const certificateDeliveries = () => db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventType, 'certificate'))

/** A reader that always reports the given expiry and counts how often it was asked. */
function fakeReader(expiresAt: () => number): CertificateReader & { calls: number } {
  const reader = Object.assign(async () => {
    reader.calls++
    return { host: 'status.example.test', expiresAt: expiresAt(), issuer: 'Test CA' }
  }, { calls: 0 })
  return reader
}

describe('certificate expiry helpers', () => {
  it('only reads certificates of HTTPS URLs', () => {
    assert.deepEqual(certificateTarget('https://example.com/path'), { host: 'example.com', port: 443 })
    assert.deepEqual(certificateTarget('https://[::1]:8443/'), { host: '::1', port: 8443 })
    assert.equal(certificateTarget('http://example.com'), null)
    assert.equal(certificateTarget('not a url'), null)
  })

  it('treats warnings as off unless enabled, and clamps the lead time', () => {
    assert.equal(normalizeCertExpiry(undefined), null)
    assert.equal(normalizeCertExpiry({ enabled: false, warnDays: 30 }), null)
    assert.deepEqual(normalizeCertExpiry({ enabled: true, warnDays: 0 }), { enabled: true, warnDays: 1 })
    assert.deepEqual(normalizeCertExpiry({ enabled: true, warnDays: 9999 }), { enabled: true, warnDays: 365 })
    assert.deepEqual(normalizeCertExpiry({ enabled: true, warnDays: Number.NaN }), { enabled: true, warnDays: 14 })
  })

  it('picks the smallest milestone reached: the lead time, then 7, 3 and 1 days', () => {
    assert.equal(certMilestone(20, 14), null)
    assert.equal(certMilestone(14, 14), 14)
    assert.equal(certMilestone(10, 14), 14)
    assert.equal(certMilestone(6.5, 14), 7)
    assert.equal(certMilestone(2, 14), 3)
    assert.equal(certMilestone(0.2, 14), 1)
    // Reminders at or above the lead time are skipped.
    assert.equal(certMilestone(4, 5), 5)
    assert.equal(certMilestone(2.5, 5), 3)
  })

  it('words the time left in whole days, rounded down', () => {
    assert.equal(expiresInPhrase(0.4), 'in less than a day')
    assert.equal(expiresInPhrase(1.9), 'in 1 day')
    assert.equal(expiresInPhrase(14.2), 'in 14 days')
  })
})

describe('checkCertificateExpiry', () => {
  it('warns once per milestone and leaves the monitor status alone', async () => {
    const monitor = await createMonitor(httpsConfig({ enabled: true, warnDays: 14 }), ['discord', 'teams', 'slack'])
    let now = Date.now()
    const expiresAt = now + 10 * DAY
    const reader = fakeReader(() => expiresAt)

    await checkCertificateExpiry(monitor, httpsConfig({ enabled: true, warnDays: 14 }), now, reader)
    let row = await reload(monitor.id)
    assert.equal(row.certExpiresAt, expiresAt)
    assert.equal(row.certWarnedDays, 14)
    assert.equal(row.currentStatus, 'up')
    assert.equal((await certificateDeliveries()).length, 3)

    const discord = JSON.parse(requests.find((r) => r.url === '/discord')!.body) as { embeds: Array<{ title: string; color: number; fields: Array<{ name: string; value: string }> }> }
    assert.equal(discord.embeds[0]!.title, 'TLS certificate of `Checkout` expires in 10 days')
    assert.equal(discord.embeds[0]!.color, 0xfb8c00)
    assert.equal(discord.embeds[0]!.fields.find((f) => f.name === 'Details')?.value.startsWith('TLS certificate for status.example.test expires in 10 days'), true)
    assert.match(requests.find((r) => r.url === '/slack')!.body, /TLS certificate of \*Checkout\* expires in 10 days/)
    assert.match(requests.find((r) => r.url === '/teams')!.body, /"themeColor":"FB8C00"/)

    // Same milestone again: nothing new.
    now += CERT_CHECK_INTERVAL_MS
    await checkCertificateExpiry(row, httpsConfig({ enabled: true, warnDays: 14 }), now, reader)
    row = await reload(monitor.id)
    assert.equal((await certificateDeliveries()).length, 3)

    // Crossing into the 7-day reminder warns again.
    now = expiresAt - 6 * DAY
    await checkCertificateExpiry(row, httpsConfig({ enabled: true, warnDays: 14 }), now, reader)
    row = await reload(monitor.id)
    assert.equal(row.certWarnedDays, 7)
    assert.equal((await certificateDeliveries()).length, 6)
  })

  it('sends an all-clear when a warned-about certificate is renewed and starts its milestones over', async () => {
    const config = httpsConfig({ enabled: true, warnDays: 14 })
    const monitor = await createMonitor(config)
    const now = Date.now()
    let expiresAt = now + 5 * DAY
    const reader = fakeReader(() => expiresAt)

    await checkCertificateExpiry(monitor, config, now, reader)
    assert.equal((await reload(monitor.id)).certWarnedDays, 7)

    expiresAt = now + 90 * DAY
    await checkCertificateExpiry(await reload(monitor.id), config, now + CERT_CHECK_INTERVAL_MS, reader)
    const row = await reload(monitor.id)
    assert.equal(row.certExpiresAt, expiresAt)
    assert.equal(row.certWarnedDays, null)
    const deliveries = await certificateDeliveries()
    assert.deepEqual(deliveries.map((d) => d.targetStatus), ['cert-expiring', 'cert-renewed'])
    const renewal = JSON.parse(requests.at(-1)!.body) as { embeds: Array<{ title: string; color: number }> }
    assert.equal(renewal.embeds[0]!.title, 'TLS certificate of `Checkout` was renewed')
    assert.equal(renewal.embeds[0]!.color, 0x43a047)
  })

  it('records the expiry without notifying when warnings are off', async () => {
    const monitor = await createMonitor(httpsConfig())
    const now = Date.now()
    await checkCertificateExpiry(monitor, httpsConfig(), now, fakeReader(() => now + 2 * DAY))
    const row = await reload(monitor.id)
    assert.equal(row.certExpiresAt, now + 2 * DAY)
    assert.equal(row.certCheckedAt, now)
    assert.equal(row.certWarnedDays, null)
    assert.equal((await certificateDeliveries()).length, 0)
  })

  it('does not warn about an already expired certificate — the failing check alerts instead', async () => {
    const config = httpsConfig({ enabled: true, warnDays: 14 })
    const monitor = await createMonitor(config)
    const now = Date.now()
    await checkCertificateExpiry(monitor, config, now, fakeReader(() => now - DAY))
    assert.equal((await certificateDeliveries()).length, 0)
  })

  it('reads the certificate at most every few hours, and skips plain HTTP', async () => {
    const config = httpsConfig({ enabled: true, warnDays: 14 })
    const now = Date.now()
    const monitor = await createMonitor(config)
    const reader = fakeReader(() => now + 100 * DAY)

    await checkCertificateExpiry({ ...monitor, certCheckedAt: now - CERT_CHECK_INTERVAL_MS + 1 }, config, now, reader)
    assert.equal(reader.calls, 0)
    await checkCertificateExpiry(monitor, { ...config, url: 'http://status.example.test' }, now, reader)
    assert.equal(reader.calls, 0)
    await checkCertificateExpiry(monitor, config, now, reader)
    assert.equal(reader.calls, 1)
  })

  it('keeps the last known expiry and retries sooner when the certificate cannot be read', async () => {
    const config = httpsConfig({ enabled: true, warnDays: 14 })
    const now = Date.now()
    const monitor = await createMonitor(config)
    await db.update(monitors).set({ certExpiresAt: now + 50 * DAY }).where(eq(monitors.id, monitor.id))
    const failing: CertificateReader = async () => { throw new Error('ECONNREFUSED') }

    const warn = console.warn
    console.warn = () => {}
    try {
      await checkCertificateExpiry(await reload(monitor.id), config, now, failing)
    } finally {
      console.warn = warn
    }
    const row = await reload(monitor.id)
    assert.equal(row.certExpiresAt, now + 50 * DAY)
    assert.equal(row.certCheckedAt! + CERT_CHECK_INTERVAL_MS, now + CERT_RETRY_INTERVAL_MS)
  })
})

describe('readCertificate', () => {
  let tlsServer: TlsServer | null = null
  let port = 0
  let expectedExpiry = 0

  before(async () => {
    // A throwaway self-signed certificate; skipped where openssl is not installed.
    const dir = testDb.dir
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=localhost',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      ], { stdio: 'ignore' })
    } catch {
      return
    }
    const cert = readFileSync(join(dir, 'cert.pem'))
    expectedExpiry = Date.parse(execFileSync('openssl', ['x509', '-enddate', '-noout', '-in', join(dir, 'cert.pem')]).toString().replace('notAfter=', '').trim())
    tlsServer = createTlsServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (socket) => socket.end())
    await new Promise<void>((resolve) => tlsServer!.listen(0, '127.0.0.1', resolve))
    const address = tlsServer.address()
    if (!address || typeof address === 'string') throw new Error('TLS server did not bind')
    port = address.port
  })

  after(async () => {
    if (tlsServer) await new Promise<void>((resolve) => tlsServer!.close(() => resolve()))
  })

  it('reads the expiry even of a certificate the check would not trust', async (t) => {
    if (!tlsServer) return t.skip('openssl is not available')
    const cert = await readCertificate(`https://localhost:${port}/`, 2_000)
    assert.equal(cert.host, 'localhost')
    assert.equal(cert.expiresAt, expectedExpiry)
    assert.equal(cert.issuer, 'localhost')
  })

  it('reports the expiry as a test-run step, flagged inside the warning window', async (t) => {
    if (!tlsServer) return t.skip('openssl is not available')
    const url = `https://localhost:${port}/`
    const plain = await certificateStep({ url, method: 'GET', expectedStatus: 200 }, 2_000)
    assert.equal(plain.status, 'ok')
    assert.match(plain.label, /^TLS certificate expires in (29|30) days$/)
    assert.match(plain.detail!, /issued by localhost$/)

    const warned = await certificateStep({ url, method: 'GET', expectedStatus: 200, certExpiry: { enabled: true, warnDays: 60 } }, 2_000)
    assert.equal(warned.status, 'info')
    assert.match(warned.detail!, /inside the 60-day warning window$/)

    const unreadable = await certificateStep({ url: 'https://127.0.0.1:1/', method: 'GET', expectedStatus: 200 }, 1_000)
    assert.equal(unreadable.label, 'TLS certificate could not be read')
  })

  it('fails for non-HTTPS URLs and unreachable endpoints', async () => {
    await assert.rejects(readCertificate('http://localhost/', 1_000), /Not an HTTPS URL/)
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const address = closed.address()
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    await assert.rejects(readCertificate(`https://127.0.0.1:${address.port}/`, 1_000))
  })

  it('times out when the endpoint never completes the handshake', async () => {
    const sockets: Socket[] = []
    // Accepts the connection but never answers the ClientHello.
    const silent = createTcpServer((socket) => { sockets.push(socket) })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const address = silent.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    try {
      await assert.rejects(readCertificate(`https://127.0.0.1:${address.port}/`, 200), /timed out/)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  })
})
