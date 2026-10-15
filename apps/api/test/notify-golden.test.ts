import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it, mock } from 'node:test'
import Fastify from 'fastify'
import { SMTPServer } from 'smtp-server'
import { db } from '../src/db/client.js'
import { actionFailureChannels, actions, monitorNotificationChannels, monitors, notificationChannels, smtpSettings } from '../src/db/schema.js'
import { notificationRoutes } from '../src/routes/notifications.js'
import {
  processDueNotificationDeliveries, sendActionFailureNotifications, sendCertificateNotifications, sendNotifications, testNotificationChannel,
} from '../src/workers/notifier.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

// Guards the extraction of the notification module: what every channel type sends for every kind of event, and the
// JSON the notification routes answer with, must not change by a byte. Regenerate on purpose with UPDATE_SNAPSHOTS=1.
const GOLDEN = fileURLToPath(new URL('./fixtures/notify-golden.json', import.meta.url))
const NOW = 1_700_000_000_000

const testDb = createTestDb('bsp-notify-golden-')
const app = Fastify({ logger: false })
const captured: Array<{ channel: string; method: string; url: string; contentType: string | null; extra: Record<string, string>; body: string }> = []
let current = ''
let host = ''
const emails: string[] = []

const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    captured.push({
      channel: current, method: request.method ?? '', url: request.url ?? '', contentType: request.headers['content-type'] ?? null,
      extra: pickHeaders(request.headers as Record<string, string | string[] | undefined>), body: Buffer.concat(chunks).toString(),
    })
    response.writeHead(204).end()
  })
})
const smtpServer = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, _session, callback) {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => { emails.push(Buffer.concat(chunks).toString()); callback() })
  },
})
let smtpPort = 0

function pickHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['title', 'priority', 'tags', 'click', 'authorization']) {
    const value = headers[name]
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/** Port and host of this run, the message ids and dates of mail and boundaries are the only things that vary. */
/** Deliveries to different channels run side by side, so the order they arrive in is not part of the contract. */
const byUrl = <T extends { url: string }>(requests: T[]) => [...requests].sort((a, b) => a.url.localeCompare(b.url))

const normalise = (text: string) => text
  .replaceAll(host, 'HOST')
  .replace(/"key":"k-[0-9a-f]+"/g, '"key":"k-RANDOM"')
  .replace(/^(Message-ID|Date): .*$/gim, '$1: -')
  .replace(/----[=_\w.-]+/g, '----BOUNDARY')
  .replace(/\r\n/g, '\n')

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW })
  initTestDb()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind')
  host = `127.0.0.1:${address.port}`
  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve))
  const smtpAddress = smtpServer.server.address()
  if (!smtpAddress || typeof smtpAddress === 'string') throw new Error('SMTP server did not bind')
  smtpPort = smtpAddress.port
  app.addHook('preHandler', async (request) => { request.user = { userId: 1, email: 'admin@example.test', role: 'admin' } })
  await app.register(notificationRoutes, { prefix: '/notifications' })
  await app.ready()
})

after(async () => {
  mock.timers.reset()
  globalThis.fetch = realFetch
  await app.close()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await new Promise<void>((resolve) => smtpServer.close(resolve))
  teardownTestDb(testDb)
})

// The channels with a fixed host (Telegram, Pushover) are answered by a stub that records what would have been sent.
const realFetch = globalThis.fetch
function stubFixedHosts() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    if (url.startsWith('https://api.telegram.org/') || url.startsWith('https://api.pushover.net/')) {
      captured.push({
        channel: current, method: init?.method ?? 'GET', url, contentType: new Headers(init?.headers).get('content-type'),
        extra: pickHeaders(Object.fromEntries(new Headers(init?.headers).entries())), body: String(init?.body ?? ''),
      })
      return new Response('{"ok":true,"status":1}', { status: 200 })
    }
    return realFetch(input, init)
  }) as typeof fetch
}

async function channelsFor(): Promise<Record<string, number>> {
  const now = NOW
  const url = (path: string) => `http://${host}${path}`
  const rows = await db.insert(notificationChannels).values([
    { name: 'Email', type: 'email', config: JSON.stringify({ to: 'team@example.test', subject: '{{monitor_name}} is {{status}}', body: 'Detail: {{error_message}}' }) },
    { name: 'Webhook', type: 'webhook', config: JSON.stringify({ url: url('/webhook'), method: 'POST', body: '{"name":"{{monitor_name}}","status":"{{status}}","event":"{{event_type}}"}' }) },
    { name: 'Discord', type: 'discord', config: JSON.stringify({ webhookUrl: url('/discord') }) },
    { name: 'Teams', type: 'teams', config: JSON.stringify({ webhookUrl: url('/teams') }) },
    { name: 'Slack', type: 'slack', config: JSON.stringify({ webhookUrl: url('/slack') }) },
    { name: 'Telegram', type: 'telegram', config: JSON.stringify({ botToken: '123:SECRET', chatId: '-100500' }) },
    { name: 'Ntfy', type: 'ntfy', config: JSON.stringify({ serverUrl: url('/ntfy-root'), topic: 'alerts' }) },
    { name: 'Pushover', type: 'pushover', config: JSON.stringify({ appToken: 'app-token', userKey: 'user-key' }) },
  ].map((channel) => ({ ...channel, enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now }))).returning()
  return Object.fromEntries(rows.map((row) => [row.name, row.id]))
}

describe('notification output', () => {
  it('matches the recorded requests, mail and route responses', async () => {
    stubFixedHosts()
    const now = NOW
    await db.insert(smtpSettings).values({
      id: 1, host: '127.0.0.1', port: smtpPort, secure: 0, user: '', password: '', fromAddress: 'status@example.test', fromName: 'Status', updatedAt: now,
    })
    const [monitor] = await db.insert(monitors).values({
      name: 'Checkout <API>', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1, config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const ids = await channelsFor()
    await db.insert(monitorNotificationChannels).values(Object.values(ids).map((channelId) => ({ monitorId: monitor!.id, channelId })))
    const [action] = await db.insert(actions).values({ name: 'Restart', config: '{}', createdAt: now, updatedAt: now }).returning()
    await db.insert(actionFailureChannels).values(Object.values(ids).map((channelId) => ({ actionId: action!.id, channelId })))

    const events: Array<[string, () => Promise<unknown>]> = [
      ['down', () => sendNotifications(monitor!, 'down', 'up', 'connection refused: "port" 443')],
      ['recovery', () => sendNotifications(monitor!, 'up', 'down', null)],
      ['degraded', () => sendNotifications(monitor!, 'degraded', 'up', 'slow response')],
      ['certificate-expiring', () => sendCertificateNotifications(monitor!, { kind: 'expiring', host: 'checkout.example.test', expiresAt: NOW + 5 * 86_400_000, daysLeft: 5 })],
      ['certificate-renewed', () => sendCertificateNotifications(monitor!, { kind: 'renewed', host: 'checkout.example.test', expiresAt: NOW + 90 * 86_400_000, daysLeft: 90 })],
      ['action-failed', () => sendActionFailureNotifications({ actionId: action!.id, actionName: 'Restart', monitorId: monitor!.id, monitorName: 'Checkout <API>', onStatus: 'down', attemptCount: 3 }, 'HTTP 500')],
    ]
    const output: Record<string, unknown> = {}
    for (const [name, run] of events) {
      captured.length = 0
      emails.length = 0
      current = name
      await run()
      await processDueNotificationDeliveries(NOW + 1)
      output[name] = {
        requests: byUrl(captured).map((request) => ({ ...request, url: normalise(request.url), body: normalise(request.body) })),
        emails: emails.map(normalise),
      }
    }

    captured.length = 0
    emails.length = 0
    const tests: Record<string, unknown> = {}
    for (const [name, id] of Object.entries(ids)) {
      current = `test-${name}`
      captured.length = 0
      emails.length = 0
      const result = await testNotificationChannel(id)
      tests[name] = { result, requests: byUrl(captured).map((request) => ({ ...request, url: normalise(request.url), body: normalise(request.body) })), emails: emails.map(normalise) }
    }
    output['test-sends'] = tests

    const get = async (url: string) => JSON.parse(normalise((await app.inject(url)).body).replace('"port":' + smtpPort, '"port":0')) as unknown
    output['routes'] = {
      channels: await get('/notifications/channels'),
      channel: await get(`/notifications/channels/${ids['Webhook']}`),
      deliveries: await get('/notifications/deliveries?limit=200'),
      delivery: await get('/notifications/deliveries/1'),
      smtp: await get('/notifications/smtp'),
    }

    const actual = JSON.stringify(output, null, 2) + '\n'
    if (process.env['UPDATE_SNAPSHOTS'] === '1' || !existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true })
      writeFileSync(GOLDEN, actual)
    }
    assert.equal(actual, readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n'))
  })
})
