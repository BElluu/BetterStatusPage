import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify, { type InjectOptions } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { SMTPServer } from 'smtp-server'
import { eq } from 'drizzle-orm'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import {
  incidentMonitors, incidentUpdates, incidents, layout, maintenanceWindows, monitors, smtpSettings,
  subscriberDeliveries, subscribers, subscriptionSettings,
} from '../src/db/schema.js'
import { publicSubscriptionRoutes } from '../src/routes/subscriptions.js'
import { feedRoutes } from '../src/routes/feeds.js'
import { incidentRoutes } from '../src/routes/incidents.js'
import { maintenanceRoutes } from '../src/routes/maintenance.js'
import { saveSubscriptionSettings, getSubscriptionSettings, normalizeSubscriptionSettings } from '../src/services/subscriptions.js'
import { isPublicAddress, validateWebhookUrl } from '../src/services/publicWebhook.js'
import { processDueSubscriberDeliveries } from '../src/workers/subscriberNotifier.js'
import { WEBHOOK_DISABLE_AFTER_FAILURES } from '@bsp/shared'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-subscriptions-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')

const emails: string[] = []
const smtpServer = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, _session, callback) {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => { emails.push(decodeMail(Buffer.concat(chunks).toString())); callback() })
  },
})
const hooks: Array<{ method: string; headers: Record<string, unknown>; body: string }> = []
let hookStatus = 204
const hookServer = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    hooks.push({ method: request.method ?? '', headers: request.headers, body: Buffer.concat(chunks).toString() })
    response.writeHead(hookStatus).end()
  })
})
let hookUrl = ''
let smtpRow: typeof smtpSettings.$inferInsert

const app = Fastify({ logger: false })
let clientCounter = 0
let publicA = 0
let publicB = 0
let internal = 0

/**
 * Undo quoted-printable soft breaks and escapes in the body so links can be read back out of raw
 * mail. Headers are left alone: they are not QP-encoded, and a token such as `token=A5…` in
 * List-Unsubscribe would otherwise be mangled into `token¥…`.
 */
function decodeMail(raw: string): string {
  const split = raw.indexOf('\r\n\r\n')
  const headers = split < 0 ? raw : raw.slice(0, split)
  const body = split < 0 ? '' : raw.slice(split)
  return headers + body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

function tokenFrom(mail: string, kind: 'confirm' | 'manage' | 'unsubscribe'): string {
  const match = mail.match(new RegExp(`subscription=${kind}&token=([A-Za-z0-9_%-]+)`))
  assert.ok(match, `no ${kind} link in mail`)
  return decodeURIComponent(match[1]!)
}

/** Every call looks like a different visitor so the per-IP subscribe limit does not interfere. */
function inject(options: InjectOptions) {
  clientCounter++
  return app.inject({ remoteAddress: `198.51.100.${clientCounter % 250}`, ...options })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function subscribeAndConfirm(body: Record<string, unknown>): Promise<string> {
  const before = emails.length
  const response = await inject({ method: 'POST', url: '/api/v1/public/subscriptions', payload: body })
  assert.equal(response.statusCode, 202, response.body)
  await waitFor(() => emails.length > before)
  const beforeConfirm = emails.length
  const confirm = await inject({
    method: 'POST', url: '/api/v1/public/subscriptions/confirm',
    payload: { token: tokenFrom(emails.at(-1)!, 'confirm') },
  })
  assert.equal(confirm.statusCode, 200, confirm.body)
  // The manage link is only ever delivered by email, never to the page that confirmed.
  assert.equal('manageToken' in confirm.json(), false)
  await waitFor(() => emails.length > beforeConfirm)
  return tokenFrom(emails.at(-1)!, 'manage')
}

async function enable(overrides: Record<string, unknown> = {}) {
  const current = await getSubscriptionSettings()
  await saveSubscriptionSettings(normalizeSubscriptionSettings({ enabled: true, allowEmail: true, ...overrides }, current))
}

/** Waits for every queued delivery to finish, including ones kicked off in the background. */
async function drainDeliveries() {
  await waitFor(async () => {
    await processDueSubscriberDeliveries()
    return (await db.select().from(subscriberDeliveries).where(eq(subscriberDeliveries.status, 'pending'))).length === 0
  })
}

/** Runs every retry of the queued deliveries to completion by stepping the clock past each backoff. */
async function exhaustDeliveries() {
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let hour = 1; hour <= 6; hour++) {
    // Twice: the first call may join a pass already in flight that still uses the real clock.
    await processDueSubscriberDeliveries(Date.now() + hour * 3_600_000)
    await processDueSubscriberDeliveries(Date.now() + hour * 3_600_000)
  }
}

before(async () => {
  initDb()
  runMigrations()
  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve))
  const smtpAddress = smtpServer.server.address()
  if (!smtpAddress || typeof smtpAddress === 'string') throw new Error('SMTP server did not bind')
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve))
  const hookAddress = hookServer.address()
  if (!hookAddress || typeof hookAddress === 'string') throw new Error('Webhook server did not bind')
  hookUrl = `http://127.0.0.1:${hookAddress.port}/hook`

  const now = Date.now()
  smtpRow = {
    id: 1, host: '127.0.0.1', port: smtpAddress.port, secure: 0, user: '', password: '',
    fromAddress: 'status@example.test', fromName: 'Status', updatedAt: now,
  }
  await db.insert(smtpSettings).values(smtpRow)
  const inserted = await db.insert(monitors).values([
    { name: 'Public API', type: 'https', config: '{}', tags: JSON.stringify([{ label: 'core', color: '#000' }]), createdAt: now, updatedAt: now },
    { name: 'Website', type: 'https', config: '{}', tags: '[]', createdAt: now, updatedAt: now },
    { name: 'Secret DB replica', type: 'https', config: '{}', tags: JSON.stringify([{ label: 'internal-only', color: '#000' }]), createdAt: now, updatedAt: now },
  ]).returning()
  ;[publicA, publicB, internal] = inserted.map((row) => row.id) as [number, number, number]
  await db.insert(layout).values({
    id: 1,
    tree: JSON.stringify({
      id: 'root', type: 'page', children: [
        { id: 'a', type: 'monitor', monitorId: publicA, showUptimeBar: true },
        { id: 'g', type: 'group', label: 'Web', collapsible: false, children: [
          { id: 'b', type: 'monitor', monitorId: publicB, showUptimeBar: true },
        ] },
      ],
    }),
    updatedAt: now,
  })

  await app.register(rateLimit, { global: false })
  app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { userId: 1, email: 'operator@example.test' } })
  await app.register(publicSubscriptionRoutes, { prefix: '/api/v1/public/subscriptions' })
  await app.register(feedRoutes, { prefix: '/api/v1/public' })
  await app.register(incidentRoutes, { prefix: '/api/v1/admin/incidents' })
  await app.register(maintenanceRoutes, { prefix: '/api/v1/admin/maintenance' })
  await app.ready()
})

beforeEach(async () => {
  emails.length = 0
  hooks.length = 0
  hookStatus = 204
  delete process.env['SUBSCRIBER_WEBHOOK_ALLOW_PRIVATE']
  // Deployment configuration: links in emails and feeds are built from it.
  process.env['PUBLIC_URL'] = 'https://status.example.test/'
  await db.delete(subscriberDeliveries)
  await db.delete(subscribers)
  await db.delete(subscriptionSettings)
  await db.delete(incidentUpdates)
  await db.delete(incidentMonitors)
  await db.delete(incidents)
  await db.delete(maintenanceWindows)
})

after(async () => {
  await app.close()
  hookServer.closeAllConnections()
  await new Promise<void>((resolve) => hookServer.close(() => resolve()))
  await new Promise<void>((resolve) => smtpServer.close(resolve))
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('status page subscriptions', () => {
  it('stays closed until an operator enables it, then offers only public components', async () => {
    let response = await inject({ url: '/api/v1/public/subscriptions/options' })
    assert.equal(response.headers['cache-control'], 'no-store')
    let options = response.json()
    assert.deepEqual(options.methods, [])
    const refused = await inject({ method: 'POST', url: '/api/v1/public/subscriptions', payload: { type: 'email', email: 'a@example.test' } })
    assert.equal(refused.statusCode, 404)

    await enable()
    response = await inject({ url: '/api/v1/public/subscriptions/options' })
    options = response.json()
    // Webhooks are off by default; every other method is on.
    assert.deepEqual(options.methods, ['email', 'slack', 'rss', 'api'])
    assert.deepEqual(options.components.map((c: { name: string }) => c.name).sort(), ['Public API', 'Website'])
    assert.deepEqual(options.tags, ['core'])
    assert.doesNotMatch(JSON.stringify(options), /Secret DB replica|internal-only/)

    const scopedToInternal = await inject({
      method: 'POST', url: '/api/v1/public/subscriptions',
      payload: { type: 'email', email: 'a@example.test', monitorIds: [internal] },
    })
    assert.equal(scopedToInternal.statusCode, 400)
  })

  it('requires double opt-in and ignores honeypot submissions', async () => {
    await enable()
    const bot = await inject({
      method: 'POST', url: '/api/v1/public/subscriptions',
      payload: { type: 'email', email: 'bot@example.test', website: 'http://spam.example' },
    })
    assert.equal(bot.statusCode, 202)
    assert.equal((await db.select().from(subscribers)).length, 0)

    const response = await inject({ method: 'POST', url: '/api/v1/public/subscriptions', payload: { type: 'email', email: 'Reader@Example.test' } })
    assert.equal(response.statusCode, 202)
    await waitFor(() => emails.length === 1)
    let [row] = await db.select().from(subscribers)
    assert.equal(row!.status, 'pending')
    assert.equal(row!.email, 'reader@example.test')
    assert.match(emails[0]!, /Subject: Confirm your subscription/)

    // A pending subscriber cannot use the manage link yet, and a bad token confirms nothing.
    const early = await inject({ method: 'POST', url: '/api/v1/public/subscriptions/preferences', payload: { token: row!.manageToken } })
    assert.equal(early.statusCode, 404)
    const wrong = await inject({ method: 'POST', url: '/api/v1/public/subscriptions/confirm', payload: { token: 'nope' } })
    assert.equal(wrong.statusCode, 404)

    const confirm = await inject({ method: 'POST', url: '/api/v1/public/subscriptions/confirm', payload: { token: tokenFrom(emails[0]!, 'confirm') } })
    assert.equal(confirm.statusCode, 200)
    assert.deepEqual(confirm.json(), { type: 'email' })
    ;[row] = await db.select().from(subscribers)
    assert.equal(row!.status, 'active')
    assert.equal(row!.confirmTokenHash, null)

    // Confirming sends one email that carries the single manage-or-unsubscribe link.
    await waitFor(() => emails.length === 2)
    assert.match(emails[1]!, /Subject: You are subscribed/)
    assert.equal(tokenFrom(emails[1]!, 'manage'), row!.manageToken)
    assert.doesNotMatch(emails[1]!, /subscription=unsubscribe/)
    const reused = await inject({ method: 'POST', url: '/api/v1/public/subscriptions/confirm', payload: { token: tokenFrom(emails[0]!, 'confirm') } })
    assert.equal(reused.statusCode, 404)

    // Re-submitting an active address neither changes it nor mails again inside the cooldown.
    const again = await inject({ method: 'POST', url: '/api/v1/public/subscriptions', payload: { type: 'email', email: 'reader@example.test', events: ['incident.resolved'] } })
    assert.equal(again.statusCode, 202)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(emails.length, 2)
    ;[row] = await db.select().from(subscribers)
    assert.equal(JSON.parse(row!.events).length, 4)
  })

  it('sends a fresh confirmation right away when someone re-subscribes after unsubscribing', async () => {
    await enable()
    const manageToken = await subscribeAndConfirm({ type: 'email', email: 'returning@example.test' })
    const left = await inject({ method: 'POST', url: '/api/v1/public/subscriptions/unsubscribe', payload: { token: manageToken } })
    assert.equal(left.statusCode, 200)
    emails.length = 0

    // Well inside the 10-minute cooldown of the first confirmation, which is already used up.
    const again = await inject({ method: 'POST', url: '/api/v1/public/subscriptions', payload: { type: 'email', email: 'returning@example.test' } })
    assert.equal(again.statusCode, 202)
    await waitFor(() => emails.length === 1)
    assert.match(emails[0]!, /Subject: Confirm your subscription/)
    assert.equal((await db.select().from(subscribers))[0]!.status, 'pending')

    // Hammering the form afterwards is still rate-limited per address.
    await inject({ method: 'POST', url: '/api/v1/public/subscriptions', payload: { type: 'email', email: 'returning@example.test' } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(emails.length, 1)

    const confirm = await inject({ method: 'POST', url: '/api/v1/public/subscriptions/confirm', payload: { token: tokenFrom(emails[0]!, 'confirm') } })
    assert.equal(confirm.statusCode, 200)
    assert.equal((await db.select().from(subscribers))[0]!.status, 'active')
    await waitFor(() => emails.length === 2)
  })

  it('delivers incident events only to subscribers whose events and components match', async () => {
    await enable()
    await subscribeAndConfirm({ type: 'email', email: 'everything@example.test' })
    await subscribeAndConfirm({ type: 'email', email: 'api-only@example.test', monitorIds: [publicA] })
    await subscribeAndConfirm({ type: 'email', email: 'core-tag@example.test', tags: ['core'] })
    await subscribeAndConfirm({ type: 'email', email: 'resolved-only@example.test', events: ['incident.resolved'] })
    emails.length = 0

    const created = await inject({
      method: 'POST', url: '/api/v1/admin/incidents',
      payload: { title: 'Website <slow>', impact: 'minor', monitorIds: [publicB, internal] },
    })
    assert.equal(created.statusCode, 200, created.body)
    const incidentId = created.json().id as number
    assert.deepEqual(created.json().monitorIds.sort(), [publicB, internal].sort())
    await drainDeliveries()
    assert.equal(emails.length, 1)
    assert.match(emails[0]!, /To: everything@example\.test/)
    assert.match(emails[0]!, /Affected: Website/)
    assert.doesNotMatch(emails[0]!, /Secret DB replica/)
    assert.match(emails[0]!, /List-Unsubscribe:\s+<https:\/\/status\.example\.test\/api\/v1\/public\/subscriptions\/unsubscribe\?token=/)
    assert.match(emails[0]!, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/)

    emails.length = 0
    const silent = await inject({
      method: 'POST', url: `/api/v1/admin/incidents/${incidentId}/updates`,
      payload: { body: 'Quiet internal note', status: 'identified', notifySubscribers: false },
    })
    assert.equal(silent.statusCode, 200)
    await drainDeliveries()
    assert.equal(emails.length, 0)

    const resolved = await inject({
      method: 'POST', url: `/api/v1/admin/incidents/${incidentId}/updates`,
      payload: { body: 'Fixed the cache', status: 'resolved' },
    })
    assert.equal(resolved.statusCode, 200)
    await drainDeliveries()
    const recipients = emails.map((mail) => mail.match(/To: (\S+)/)![1]).sort()
    assert.deepEqual(recipients, ['everything@example.test', 'resolved-only@example.test'])
    assert.ok(emails.every((mail) => /Status: Resolved/.test(mail) &&/Fixed the cache/.test(mail)))

    emails.length = 0
    const apiIncident = await inject({ method: 'POST', url: '/api/v1/admin/incidents', payload: { title: 'API errors', monitorIds: [publicA] } })
    assert.equal(apiIncident.statusCode, 200)
    await drainDeliveries()
    assert.deepEqual(emails.map((mail) => mail.match(/To: (\S+)/)![1]).sort(),
      ['api-only@example.test', 'core-tag@example.test', 'everything@example.test'])
  })

  it('stops sending after one-click unsubscribe and lets subscribers manage preferences', async () => {
    await enable()
    const manageToken = await subscribeAndConfirm({ type: 'email', email: 'leaving@example.test' })

    const prefs = await inject({ method: 'POST', url: '/api/v1/public/subscriptions/preferences', payload: { token: manageToken } })
    assert.equal(prefs.statusCode, 200)
    assert.equal(prefs.json().email.includes('leaving@'), false)
    const narrowed = await inject({
      method: 'PUT', url: '/api/v1/public/subscriptions/preferences',
      payload: { token: manageToken, events: ['maintenance.scheduled'], monitorIds: [publicB] },
    })
    assert.equal(narrowed.statusCode, 200)
    assert.deepEqual(narrowed.json().events, ['maintenance.scheduled'])

    emails.length = 0
    const maintenance = await inject({
      method: 'POST', url: '/api/v1/admin/maintenance',
      payload: { name: 'DB upgrade', startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000, monitorIds: [publicB] },
    })
    assert.equal(maintenance.statusCode, 200)
    await drainDeliveries()
    assert.equal(emails.length, 1)
    assert.match(emails[0]!, /Scheduled maintenance: DB upgrade/)

    const oneClick = await inject({
      method: 'POST', url: `/api/v1/public/subscriptions/unsubscribe?token=${encodeURIComponent(manageToken)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    })
    assert.equal(oneClick.statusCode, 200, oneClick.body)
    assert.equal((await db.select().from(subscribers))[0]!.status, 'unsubscribed')

    emails.length = 0
    await inject({
      method: 'POST', url: '/api/v1/admin/maintenance',
      payload: { name: 'Second window', startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000, monitorIds: [publicB] },
    })
    await drainDeliveries()
    assert.equal(emails.length, 0)

    const back = await inject({
      method: 'PUT', url: '/api/v1/public/subscriptions/preferences',
      payload: { token: manageToken, events: ['incident.created'], resubscribe: true },
    })
    assert.equal(back.json().status, 'active')
  })

  it('offers webhooks only when allowed and confirms them by email', async () => {
    await enable()
    const refused = await inject({
      method: 'POST', url: '/api/v1/public/subscriptions',
      payload: { type: 'webhook', email: 'ops@example.test', webhookUrl: 'https://hooks.example.test/x' },
    })
    assert.equal(refused.statusCode, 400)

    await enable({ allowWebhook: true })
    const privateRefused = await inject({
      method: 'POST', url: '/api/v1/public/subscriptions',
      payload: { type: 'webhook', email: 'ops@example.test', webhookUrl: hookUrl },
    })
    assert.equal(privateRefused.statusCode, 400)

    process.env['SUBSCRIBER_WEBHOOK_ALLOW_PRIVATE'] = 'true'
    const reserved = await inject({
      method: 'POST', url: '/api/v1/public/subscriptions',
      payload: { type: 'webhook', email: 'ops@example.test', webhookUrl: hookUrl, webhookHeaders: [{ name: 'Host', value: 'evil' }] },
    })
    assert.equal(reserved.statusCode, 400)
    const injected = await inject({
      method: 'POST', url: '/api/v1/public/subscriptions',
      payload: { type: 'webhook', email: 'ops@example.test', webhookUrl: hookUrl, webhookHeaders: [{ name: 'X-Token', value: 'a\r\nHost: evil' }] },
    })
    assert.equal(injected.statusCode, 400)

    const manageToken = await subscribeAndConfirm({
      type: 'webhook', email: 'ops@example.test', webhookUrl: hookUrl, webhookMethod: 'PUT',
      webhookHeaders: [{ name: 'Authorization', value: 'Bearer s3cret' }], notifyOnFailure: true,
    })
    // Nothing reached the endpoint before confirmation — the link went by email.
    assert.equal(hooks.length, 0)
    const [row] = await db.select().from(subscribers)
    assert.doesNotMatch(row!.webhookHeaders ?? '', /s3cret/)

    const prefs = (await inject({ method: 'POST', url: '/api/v1/public/subscriptions/preferences', payload: { token: manageToken } })).json()
    assert.deepEqual(prefs.webhookHeaderNames, ['Authorization'])
    assert.equal(JSON.stringify(prefs).includes('s3cret'), false)

    const created = await inject({ method: 'POST', url: '/api/v1/admin/incidents', payload: { title: 'Checkout down', impact: 'major', monitorIds: [publicA] } })
    assert.equal(created.statusCode, 200)
    await inject({ method: 'POST', url: `/api/v1/admin/incidents/${created.json().id}/updates`, payload: { body: 'Rolling back', status: 'identified' } })
    await drainDeliveries()
    assert.equal(hooks.length, 2)
    const hook = hooks[1]!
    assert.equal(hook.method, 'PUT')
    assert.equal(hook.headers['authorization'], 'Bearer s3cret')
    assert.equal(hook.headers['content-type'], 'application/json')
    assert.equal(hook.headers['x-bsp-event'], 'incident.updated')
    const payload = JSON.parse(hook.body)
    assert.equal(payload.event, 'incident.updated')
    assert.equal(payload.incident.title, 'Checkout down')
    assert.equal(payload.incident.updates.length, 1)
    assert.equal(payload.update.body, 'Rolling back')
    assert.deepEqual(payload.components, [{ id: publicA, name: 'Public API' }])
    assert.match(payload.meta.manageUrl, /^https:\/\/status\.example\.test\/#subscription=manage&token=/)
    assert.equal('unsubscribeUrl' in payload.meta, false)

    // Editing keeps a header whose value is left empty, so secrets never have to be sent back.
    const edited = await inject({
      method: 'PUT', url: '/api/v1/public/subscriptions/preferences',
      payload: { token: manageToken, webhookMethod: 'POST', webhookHeaders: [{ name: 'Authorization', value: '' }, { name: 'X-Team', value: 'ops' }] },
    })
    assert.equal(edited.statusCode, 200, edited.body)
    hooks.length = 0
    await inject({ method: 'POST', url: '/api/v1/admin/incidents', payload: { title: 'Second', monitorIds: [publicA] } })
    await drainDeliveries()
    assert.equal(hooks[0]!.method, 'POST')
    assert.equal(hooks[0]!.headers['authorization'], 'Bearer s3cret')
    assert.equal(hooks[0]!.headers['x-team'], 'ops')
  })

  it('alerts the owner when a webhook fails and pauses it after repeated failures', async () => {
    await enable({ allowWebhook: true })
    process.env['SUBSCRIBER_WEBHOOK_ALLOW_PRIVATE'] = 'true'
    const manageToken = await subscribeAndConfirm({ type: 'webhook', email: 'ops@example.test', webhookUrl: hookUrl, notifyOnFailure: true })
    emails.length = 0
    hookStatus = 500

    for (let i = 1; i <= WEBHOOK_DISABLE_AFTER_FAILURES; i++) {
      await inject({ method: 'POST', url: '/api/v1/admin/incidents', payload: { title: `Outage ${i}` } })
      await exhaustDeliveries()
      const [row] = await db.select().from(subscribers)
      assert.equal(row!.consecutiveFailures, i)
    }

    const [row] = await db.select().from(subscribers)
    assert.equal(row!.status, 'disabled')
    // One alert for the first failure (then at most daily), plus the pause notice.
    await waitFor(() => emails.length === 2)
    assert.match(emails[0]!, /could not deliver a status update/)
    assert.match(emails[0]!, /HTTP 500/)
    assert.match(emails[1]!, /we have paused it/)

    hooks.length = 0
    hookStatus = 204
    await inject({ method: 'POST', url: '/api/v1/admin/incidents', payload: { title: 'While paused' } })
    await drainDeliveries()
    assert.equal(hooks.length, 0)

    const resumed = await inject({
      method: 'PUT', url: '/api/v1/public/subscriptions/preferences',
      payload: { token: manageToken, events: ['incident.created'], resubscribe: true },
    })
    assert.equal(resumed.json().status, 'active')
    const [reset] = await db.select().from(subscribers)
    assert.equal(reset!.consecutiveFailures, 0)
    await inject({ method: 'POST', url: '/api/v1/admin/incidents', payload: { title: 'Back again' } })
    await drainDeliveries()
    assert.equal(hooks.length, 1)
  })

  it('sends no failure email to subscribers who did not ask for one, but still announces the pause', async () => {
    await enable({ allowWebhook: true })
    process.env['SUBSCRIBER_WEBHOOK_ALLOW_PRIVATE'] = 'true'
    await subscribeAndConfirm({ type: 'webhook', email: 'quiet@example.test', webhookUrl: hookUrl })
    emails.length = 0
    hookStatus = 500
    for (let i = 1; i <= WEBHOOK_DISABLE_AFTER_FAILURES; i++) {
      await inject({ method: 'POST', url: '/api/v1/admin/incidents', payload: { title: `Outage ${i}` } })
      await exhaustDeliveries()
    }
    await waitFor(() => emails.length === 1)
    assert.match(emails[0]!, /we have paused it/)
  })

  it('refuses webhook targets inside private networks', () => {
    assert.equal(isPublicAddress('127.0.0.1'), false)
    assert.equal(isPublicAddress('10.1.2.3'), false)
    assert.equal(isPublicAddress('169.254.169.254'), false)
    assert.equal(isPublicAddress('::1'), false)
    assert.equal(isPublicAddress('::ffff:127.0.0.1'), false)
    assert.equal(isPublicAddress('fd00::1'), false)
    assert.equal(isPublicAddress('93.184.216.34'), true)
    assert.match(validateWebhookUrl('http://hooks.example.com/x')!, /https/)
    assert.match(validateWebhookUrl('https://localhost/x')!, /public host/)
    assert.match(validateWebhookUrl('https://[::1]/x')!, /public host/)
    assert.match(validateWebhookUrl('https://user:pw@hooks.example.com/x')!, /credentials/)
    assert.equal(validateWebhookUrl('https://hooks.example.com/x'), null)
  })

  it('publishes escaped RSS and Atom feeds that can be switched off', async () => {
    // Feeds follow the master switch like every other method.
    assert.equal((await inject({ url: '/api/v1/public/incidents.rss' })).statusCode, 404)
    await enable()
    const now = Date.now()
    const [incident] = await db.insert(incidents).values({
      title: 'Payments & <billing>', status: 'monitoring', impact: 'major', startedAt: now, createdAt: now, updatedAt: now,
    }).returning()
    await db.insert(incidentUpdates).values({ incidentId: incident!.id, body: 'Rolled back deploy', status: 'monitoring', postedAt: now })
    await db.insert(incidentMonitors).values([{ incidentId: incident!.id, monitorId: publicA }, { incidentId: incident!.id, monitorId: internal }])

    const rss = await inject({ url: '/api/v1/public/incidents.rss' })
    assert.equal(rss.statusCode, 200)
    assert.match(String(rss.headers['content-type']), /application\/rss\+xml/)
    assert.match(rss.body, /<title>Payments &amp; &lt;billing&gt; — Monitoring<\/title>/)
    assert.match(rss.body, /Rolled back deploy/)
    assert.match(rss.body, /Affected: Public API/)
    assert.doesNotMatch(rss.body, /Secret DB replica/)

    const atom = await inject({ url: '/api/v1/public/incidents.atom' })
    assert.equal(atom.statusCode, 200)
    assert.match(atom.body, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/)

    await enable({ rssEnabled: false })
    assert.equal((await inject({ url: '/api/v1/public/incidents.rss' })).statusCode, 404)
  })

  it('serves a Slack event feed with one item per allowed publication', async () => {
    assert.equal((await inject({ url: '/api/v1/public/slack.rss' })).statusCode, 404)
    await enable({ allowedEvents: ['incident.created', 'incident.resolved', 'maintenance.scheduled'] })
    const options = (await inject({ url: '/api/v1/public/subscriptions/options' })).json()
    assert.equal(options.baseUrl, 'https://status.example.test')

    const now = Date.now()
    const [incident] = await db.insert(incidents).values({
      title: 'Login & SSO', status: 'resolved', impact: 'major', startedAt: now - 3_000, createdAt: now - 3_000, updatedAt: now,
    }).returning()
    await db.insert(incidentMonitors).values([{ incidentId: incident!.id, monitorId: publicA }, { incidentId: incident!.id, monitorId: internal }])
    await db.insert(incidentUpdates).values([
      { incidentId: incident!.id, body: 'Looking into it', status: 'identified', postedAt: now - 2_000 },
      { incidentId: incident!.id, body: 'All good again', status: 'resolved', postedAt: now - 1_000 },
    ])
    await db.insert(maintenanceWindows).values({
      name: 'Network work', startsAt: now + 3_600_000, endsAt: now + 7_200_000, description: null, createdAt: now, updatedAt: now,
    })

    const feed = await inject({ url: '/api/v1/public/slack.rss' })
    assert.equal(feed.statusCode, 200)
    const titles = [...feed.body.matchAll(/<item>\s*<title>([^<]*)<\/title>/g)].map((match) => match[1])
    // Newest first; the 'identified' update is left out because incident updates are not allowed.
    assert.deepEqual(titles, [
      'Scheduled maintenance: Network work',
      'Resolved: Login &amp; SSO',
      'New incident: Login &amp; SSO',
    ])
    assert.match(feed.body, /Affected: Public API/)
    assert.doesNotMatch(feed.body, /Looking into it|Secret DB replica/)

    await enable({ allowSlack: false })
    assert.equal((await inject({ url: '/api/v1/public/slack.rss' })).statusCode, 404)
    assert.equal((await inject({ url: '/api/v1/public/subscriptions/options' })).json().methods.includes('slack'), false)
  })

  it('offers only the methods whose requirements are met', async () => {
    await db.delete(smtpSettings)
    delete process.env['PUBLIC_URL']
    await enable({ allowWebhook: true })
    // Without SMTP and a public URL, email and webhook cannot confirm anyone — only feeds remain.
    const options = (await inject({ url: '/api/v1/public/subscriptions/options' })).json()
    assert.deepEqual(options.methods, ['slack', 'rss', 'api'])
    const refused = await inject({ method: 'POST', url: '/api/v1/public/subscriptions', payload: { type: 'email', email: 'a@example.test' } })
    assert.equal(refused.statusCode, 404)
    assert.equal(options.baseUrl, null)
    await db.insert(smtpSettings).values(smtpRow)
  })

  it('ignores a PUBLIC_URL that is not an absolute http(s) URL', async () => {
    process.env['PUBLIC_URL'] = 'status.example.test'
    await enable()
    const options = (await inject({ url: '/api/v1/public/subscriptions/options' })).json()
    assert.equal(options.baseUrl, null)
    assert.equal(options.methods.includes('email'), false)
  })

  it('rate limits the subscribe form per client', async () => {
    await enable()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/public/subscriptions', remoteAddress: '203.0.113.99',
        payload: { type: 'email', email: `flood${i}@example.test` },
      })
      statuses.push(response.statusCode)
    }
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429])
    await waitFor(() => emails.length === 5)
  })
})
