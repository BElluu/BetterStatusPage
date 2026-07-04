import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { SMTPServer } from 'smtp-server'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { monitorNotificationChannels, monitors, notificationChannels, smtpSettings } from '../src/db/schema.js'
import { sendNotifications } from '../src/workers/notifier.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-notifier-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
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
const emails: string[] = []
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

before(async () => {
  initDb()
  runMigrations()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Notifier server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve))
  const smtpAddress = smtpServer.server.address()
  if (!smtpAddress || typeof smtpAddress === 'string') throw new Error('SMTP server did not bind')
  smtpPort = smtpAddress.port
})

beforeEach(async () => {
  requests.length = 0
  emails.length = 0
  await db.delete(monitorNotificationChannels)
  await db.delete(notificationChannels)
  await db.delete(monitors)
  await db.delete(smtpSettings)
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await new Promise<void>((resolve) => smtpServer.close(resolve))
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('notification delivery', () => {
  it('delivers templated webhook, Discord, Teams, and Slack alerts', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Checkout API', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const channels = await db.insert(notificationChannels).values([
      { name: 'Email', type: 'email', config: JSON.stringify({ to: 'team@example.test', subject: '{{monitor_name}} {{status}}', body: '{{error_message}}' }), enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now },
      { name: 'Webhook', type: 'webhook', config: JSON.stringify({ url: `${baseUrl}/webhook`, method: 'POST', body: '{"name":"{{monitor_name}}","status":"{{status}}"}' }), enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now },
      { name: 'Discord', type: 'discord', config: JSON.stringify({ webhookUrl: `${baseUrl}/discord` }), enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now },
      { name: 'Teams', type: 'teams', config: JSON.stringify({ webhookUrl: `${baseUrl}/teams` }), enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now },
      { name: 'Slack', type: 'slack', config: JSON.stringify({ webhookUrl: `${baseUrl}/slack` }), enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now },
      { name: 'Disabled', type: 'webhook', config: JSON.stringify({ url: `${baseUrl}/disabled`, method: 'POST' }), enabled: 0, notifyOnRecovery: 1, createdAt: now, updatedAt: now },
    ]).returning()
    await db.insert(smtpSettings).values({
      id: 1, host: '127.0.0.1', port: smtpPort, secure: 0, user: '', password: '',
      fromAddress: 'status@example.test', fromName: 'Status', updatedAt: now,
    })
    await db.insert(monitorNotificationChannels).values(channels.map((channel) => ({ monitorId: monitor!.id, channelId: channel.id })))

    await sendNotifications(monitor!, 'down', 'up', 'connection failed')

    assert.deepEqual(requests.map((request) => request.url).sort(), ['/discord', '/slack', '/teams', '/webhook'])
    assert.match(requests.find((request) => request.url === '/webhook')!.body, /Checkout API/)
    assert.match(requests.find((request) => request.url === '/discord')!.body, /connection failed/)
    assert.equal(emails.length, 1)
    assert.match(emails[0]!, /Subject: Checkout API down/)
    assert.match(emails[0]!, /connection failed/)
  })

  it('respects recovery flags and suppresses affected transitions', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'API', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'down', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const [channel] = await db.insert(notificationChannels).values({
      name: 'No recovery', type: 'webhook', config: JSON.stringify({ url: `${baseUrl}/recovery`, method: 'POST' }),
      enabled: 1, notifyOnRecovery: 0, createdAt: now, updatedAt: now,
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })

    await sendNotifications(monitor!, 'up', 'down', null)
    await sendNotifications(monitor!, 'affected', 'up', null)
    assert.equal(requests.length, 0)
  })
})
