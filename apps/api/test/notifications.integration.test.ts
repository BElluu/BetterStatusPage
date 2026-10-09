import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { SMTPServer } from 'smtp-server'
import { db } from '../src/db/client.js'
import { monitorNotificationChannels, monitors, notificationChannels, notificationDeliveries, notificationDeliveryAttempts, smtpSettings, vaults, vaultSecrets } from '../src/db/schema.js'
import { encrypt } from '../src/crypto/vault.js'
import { processDueNotificationDeliveries, purgeOldNotificationDeliveries, retryNotificationDelivery, sendNotifications } from '../src/workers/notifier.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-notifier-test-')
const requests: Array<{ url: string; body: string }> = []
let flakyFailuresRemaining = 0
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    requests.push({ url: request.url ?? '', body: Buffer.concat(chunks).toString() })
    if (request.url === '/flaky' && flakyFailuresRemaining-- > 0) {
      response.writeHead(500).end()
      return
    }
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
  initTestDb()
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
  flakyFailuresRemaining = 0
  await db.delete(notificationDeliveryAttempts)
  await db.delete(notificationDeliveries)
  await db.delete(monitorNotificationChannels)
  await db.delete(notificationChannels)
  await db.delete(monitors)
  await db.delete(smtpSettings)
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await new Promise<void>((resolve) => smtpServer.close(resolve))
  teardownTestDb(testDb)
})

describe('notification delivery', () => {
  it('escapes template variables in the webhook JSON body', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Escape API', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const [channel] = await db.insert(notificationChannels).values({
      name: 'Escaped webhook', type: 'webhook', enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
      config: JSON.stringify({ url: `${baseUrl}/escaped`, method: 'POST', body: '{"error":"{{error_message}}"}' }),
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })

    await sendNotifications(monitor!, 'down', 'up', 'said "no"\nline two')

    const request = requests.find((r) => r.url === '/escaped')!
    assert.deepEqual(JSON.parse(request.body), { error: 'said "no"\nline two' })
  })

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
    assert.equal(JSON.parse(requests.find((request) => request.url === '/discord')!.body).avatar_url, 'https://docs.betterstatuspage.dev/discord-avatar.png')
    assert.equal(emails.length, 1)
    assert.match(emails[0]!, /Subject: Checkout API down/)
    assert.match(emails[0]!, /connection failed/)
    const deliveries = await db.select().from(notificationDeliveries)
    assert.equal(deliveries.length, 5)
    assert.ok(deliveries.every((delivery) => delivery.status === 'delivered' && delivery.attemptCount === 1))
    assert.equal((await db.select().from(notificationDeliveryAttempts)).length, 5)
  })

  it('sends a Telegram alert through the bot API with escaped HTML and a bounded length', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Checkout <API>', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const [channel] = await db.insert(notificationChannels).values({
      name: 'Telegram', type: 'telegram', enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
      config: JSON.stringify({ botToken: '123:SECRET', chatId: '-100500', text: 'Heads up {{monitor_name}}' }),
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })

    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      await sendNotifications(monitor!, 'down', 'up', `<b>boom</b> & ${'x'.repeat(5_000)}`)
    } finally {
      globalThis.fetch = realFetch
    }

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.telegram.org/bot123:SECRET/sendMessage')
    const body = calls[0]!.body
    assert.equal(body['chat_id'], '-100500')
    assert.equal(body['parse_mode'], 'HTML')
    const text = String(body['text'])
    assert.ok(text.length <= 4096)
    assert.match(text, /^Heads up Checkout &lt;API&gt;\n/)
    assert.match(text, /<b>Checkout &lt;API&gt;<\/b> is <b>DOWN<\/b>/)
    assert.match(text, /&lt;b&gt;boom&lt;\/b&gt; &amp; x+…\n<i>Checked at /)
  })

  it('reads the Telegram bot token from a vault secret', async () => {
    process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)
    const now = Date.now()
    const [vault] = await db.insert(vaults).values({ name: 'Alerts', description: '', createdAt: now, updatedAt: now }).returning()
    const [secret] = await db.insert(vaultSecrets).values({
      vaultId: vault!.id, name: 'bot', type: 'value', encryptedValue: encrypt(JSON.stringify({ value: '555:FROMVAULT' })), createdAt: now, updatedAt: now,
    }).returning()
    const [monitor] = await db.insert(monitors).values({
      name: 'API', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const [channel] = await db.insert(notificationChannels).values({
      name: 'Telegram vault', type: 'telegram', enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
      config: JSON.stringify({ vault: { vaultId: vault!.id, secretId: secret!.id }, chatId: '-100500' }),
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })

    const urls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => { urls.push(String(input)); return new Response('{}', { status: 200 }) }) as typeof fetch
    try {
      await sendNotifications(monitor!, 'down', 'up', 'boom')
    } finally {
      globalThis.fetch = realFetch
    }
    assert.deepEqual(urls, ['https://api.telegram.org/bot555:FROMVAULT/sendMessage'])
  })

  it('does not leak the Telegram bot token into a failed delivery', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Token API', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const [channel] = await db.insert(notificationChannels).values({
      name: 'Telegram', type: 'telegram', enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
      config: JSON.stringify({ botToken: '123:SECRET', chatId: '1' }),
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })

    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch
    try {
      await sendNotifications(monitor!, 'down', 'up', 'down')
    } finally {
      globalThis.fetch = realFetch
    }

    const [delivery] = await db.select().from(notificationDeliveries)
    assert.equal(delivery!.status, 'pending')
    assert.equal(delivery!.lastError, 'Telegram API returned HTTP 401')
  })

  it('reports Telegram\'s error description and escapes literal HTML in the Message Text', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Parse API', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const [channel] = await db.insert(notificationChannels).values({
      name: 'Telegram', type: 'telegram', enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
      config: JSON.stringify({ botToken: '123:SECRET', chatId: '1', text: 'ping <team> & co' }),
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })

    let sentText = ''
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      sentText = String(JSON.parse(String(init?.body)).text)
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })
    }) as typeof fetch
    try {
      await sendNotifications(monitor!, 'down', 'up', 'down')
    } finally {
      globalThis.fetch = realFetch
    }

    assert.match(sentText, /^ping &lt;team&gt; &amp; co\n/)
    const [delivery] = await db.select().from(notificationDeliveries)
    assert.equal(delivery!.lastError, 'Telegram API returned HTTP 400: Bad Request: chat not found')
    assert.ok(!delivery!.lastError!.includes('SECRET'))
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
    assert.equal((await db.select().from(notificationDeliveries)).length, 0)
  })

  it('sends the all-clear for down → affected → up, but not for an affected spell that never alerted', async () => {
    const now = Date.now()
    const [alerted, quiet] = await db.insert(monitors).values([
      { name: 'Alerted', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1, config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now },
      { name: 'Quiet', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1, config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now },
    ]).returning()
    const [channel] = await db.insert(notificationChannels).values({
      name: 'Ops', type: 'webhook', config: JSON.stringify({ url: `${baseUrl}/ops`, method: 'POST' }),
      enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
    }).returning()
    await db.insert(monitorNotificationChannels).values([
      { monitorId: alerted!.id, channelId: channel!.id },
      { monitorId: quiet!.id, channelId: channel!.id },
    ])

    await sendNotifications(alerted!, 'down', 'up', 'timeout')
    await sendNotifications(alerted!, 'affected', 'down', null)
    await sendNotifications(alerted!, 'up', 'affected', null)
    await sendNotifications(quiet!, 'affected', 'up', null)
    await sendNotifications(quiet!, 'up', 'affected', null)

    const deliveries = await db.select().from(notificationDeliveries)
    assert.deepEqual(deliveries.map((d) => [d.monitorName, d.eventType]), [['Alerted', 'alert'], ['Alerted', 'recovery']])
    assert.equal(requests.length, 2)
  })

  it('retries with backoff, records every attempt, and supports manual retry', async () => {
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'Flaky API', type: 'https', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'up', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const [channel] = await db.insert(notificationChannels).values({
      name: 'Flaky webhook', type: 'webhook', config: JSON.stringify({ url: `${baseUrl}/flaky`, method: 'POST' }),
      enabled: 1, notifyOnRecovery: 1, createdAt: now, updatedAt: now,
    }).returning()
    await db.insert(monitorNotificationChannels).values({ monitorId: monitor!.id, channelId: channel!.id })
    flakyFailuresRemaining = 3

    await sendNotifications(monitor!, 'down', 'up', 'timeout')
    let [delivery] = await db.select().from(notificationDeliveries)
    assert.equal(delivery!.status, 'pending')
    assert.equal(delivery!.attemptCount, 1)

    await processDueNotificationDeliveries(now + 2 * 60_000)
    await processDueNotificationDeliveries(now + 10 * 60_000)
    ;[delivery] = await db.select().from(notificationDeliveries)
    assert.equal(delivery!.status, 'failed')
    assert.equal(delivery!.attemptCount, 3)
    assert.equal((await db.select().from(notificationDeliveryAttempts)).length, 3)

    flakyFailuresRemaining = 0
    assert.equal(await retryNotificationDelivery(delivery!.id), true)
    ;[delivery] = await db.select().from(notificationDeliveries)
    assert.equal(delivery!.status, 'delivered')
    assert.equal(delivery!.attemptCount, 4)
    assert.equal((await db.select().from(notificationDeliveryAttempts)).length, 4)

    await db.update(notificationDeliveries).set({ createdAt: now - 181 * 24 * 60 * 60 * 1000 })
    await purgeOldNotificationDeliveries(now)
    assert.equal((await db.select().from(notificationDeliveries)).length, 0)
    assert.equal((await db.select().from(notificationDeliveryAttempts)).length, 0)
  })
})
