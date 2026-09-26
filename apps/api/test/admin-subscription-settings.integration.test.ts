import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { auditLog, smtpSettings, subscribers } from '../src/db/schema.js'
import { adminSubscriberRoutes } from '../src/routes/subscriptions.js'
import { SUBSCRIBER_EVENT_TYPES } from '@bsp/shared'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-admin-subscriptions-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
const originalPublicUrl = process.env['PUBLIC_URL']
delete process.env['PUBLIC_URL']

const app = Fastify({ logger: false })
let subscriberCounter = 0

async function settingsAudit() {
  return db.select().from(auditLog).where(eq(auditLog.entityType, 'subscription_settings'))
}

async function addSubscriber(values: Partial<typeof subscribers.$inferInsert> = {}) {
  subscriberCounter++
  const email = values.email ?? `person${subscriberCounter}@example.test`
  const [row] = await db.insert(subscribers).values({
    type: 'email',
    targetKey: `email:${email}-${subscriberCounter}`,
    email,
    status: 'active',
    events: JSON.stringify(SUBSCRIBER_EVENT_TYPES),
    manageToken: `manage-${subscriberCounter}`,
    createdAt: subscriberCounter,
    updatedAt: subscriberCounter,
    ...values,
  }).returning()
  return row!
}

before(async () => {
  initDb()
  runMigrations()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 7, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(adminSubscriberRoutes, { prefix: '/admin/subscribers' })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
  if (originalPublicUrl === undefined) delete process.env['PUBLIC_URL']
  else process.env['PUBLIC_URL'] = originalPublicUrl
  rmSync(dataDir, { recursive: true, force: true })
})

describe('admin subscription settings', () => {
  it('returns defaults with the environment problems explained per method', async () => {
    const response = await app.inject({ url: '/admin/subscribers/settings' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.enabled, false)
    assert.equal(body.updatedAt, 0)
    assert.equal(body.smtpConfigured, false)
    assert.equal(body.publicUrl, '')
    assert.deepEqual(Object.keys(body.methods).sort(), ['api', 'email', 'rss', 'slack', 'webhook'])
    // Everything is off globally; email additionally lacks SMTP and a public URL.
    assert.deepEqual(body.methods.email, { enabled: true, available: false, problems: ['disabled', 'smtp', 'publicUrl'] })
    // A switched-off method never lists problems.
    assert.deepEqual(body.methods.webhook, { enabled: false, available: false, problems: [] })
    assert.deepEqual(body.methods.rss, { enabled: true, available: false, problems: ['disabled'] })
  })

  it('rejects unknown event types with 400 and writes nothing', async () => {
    for (const allowedEvents of [['incident.created', 'monitor.exploded'], 'incident.created', [42]]) {
      const response = await app.inject({ method: 'PUT', url: '/admin/subscribers/settings', payload: { allowedEvents } })
      assert.equal(response.statusCode, 400, JSON.stringify(allowedEvents))
      assert.match(response.json().error, /Allowed events must be a subset of/)
    }
    assert.equal((await settingsAudit()).length, 0)
    const settings = await app.inject({ url: '/admin/subscribers/settings' })
    assert.equal(settings.json().updatedAt, 0)
  })

  it('saves settings, audits the first save as create and later changes as update', async () => {
    process.env['PUBLIC_URL'] = 'https://status.example.test/'
    await db.insert(smtpSettings).values({ id: 1, host: 'smtp.example.test', updatedAt: Date.now() })

    const created = await app.inject({
      method: 'PUT', url: '/admin/subscribers/settings',
      // Events come back in canonical order, deduplicated.
      payload: { enabled: true, allowedEvents: ['incident.resolved', 'incident.created', 'incident.created'] },
    })
    assert.equal(created.statusCode, 200, created.body)
    const body = created.json()
    assert.equal(body.enabled, true)
    assert.deepEqual(body.allowedEvents, ['incident.created', 'incident.resolved'])
    assert.ok(body.updatedAt > 0)
    assert.equal(body.smtpConfigured, true)
    assert.equal(body.publicUrl, 'https://status.example.test')
    assert.deepEqual(body.methods.email, { enabled: true, available: true, problems: [] })

    let audit = await settingsAudit()
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.action, 'create')
    assert.equal(audit[0]!.userEmail, 'admin@example.test')
    const diff = JSON.parse(audit[0]!.diff!) as Record<string, { from: unknown; to: unknown }>
    assert.deepEqual(diff['enabled'], { from: false, to: true })
    assert.deepEqual(diff['allowedEvents'], { from: SUBSCRIBER_EVENT_TYPES.join(', '), to: 'incident.created, incident.resolved' })

    const updated = await app.inject({ method: 'PUT', url: '/admin/subscribers/settings', payload: { allowedEvents: [], allowSlack: false } })
    assert.equal(updated.statusCode, 200)
    // Omitted fields keep their saved value.
    assert.equal(updated.json().enabled, true)
    assert.deepEqual(updated.json().methods.email.problems, ['events'])
    audit = await settingsAudit()
    assert.equal(audit.length, 2)
    assert.equal(audit[1]!.action, 'update')
    const updateDiff = JSON.parse(audit[1]!.diff!) as Record<string, unknown>
    assert.deepEqual(Object.keys(updateDiff).sort(), ['allowSlack', 'allowedEvents'])
    assert.deepEqual(updateDiff['allowedEvents'], { from: 'incident.created, incident.resolved', to: 'none' })
  })

  it('does not audit a save that changes nothing', async () => {
    const before = (await settingsAudit()).length
    const current = (await app.inject({ url: '/admin/subscribers/settings' })).json()
    const response = await app.inject({ method: 'PUT', url: '/admin/subscribers/settings', payload: { enabled: current.enabled } })
    assert.equal(response.statusCode, 200)
    assert.equal((await settingsAudit()).length, before)
  })
})

describe('admin subscriber list', () => {
  beforeEach(() => sqlite.exec('DELETE FROM subscribers'))

  it('paginates, filters by status and reports per-status totals', async () => {
    for (let i = 0; i < 3; i++) await addSubscriber()
    await addSubscriber({ status: 'pending' })
    await addSubscriber({ status: 'unsubscribed' })
    await addSubscriber({ type: 'webhook', email: '', webhookUrl: 'https://hooks.example.test/a', status: 'disabled' })

    const first = (await app.inject({ url: '/admin/subscribers?limit=2' })).json()
    assert.equal(first.subscribers.length, 2)
    assert.equal(first.total, 6)
    assert.equal(first.pages, 3)
    assert.deepEqual(first.stats, { total: 6, active: 3, pending: 1, unsubscribed: 1, disabled: 1 })
    // Newest first.
    assert.ok(first.subscribers[0].createdAt > first.subscribers[1].createdAt)

    const active = (await app.inject({ url: '/admin/subscribers?status=active' })).json()
    assert.equal(active.total, 3)
    assert.ok(active.subscribers.every((s: { status: string }) => s.status === 'active'))
    // Stats always describe the whole list, not the filtered page.
    assert.equal(active.stats.total, 6)
  })

  it('falls back to sane paging for invalid or out-of-range values', async () => {
    await addSubscriber()
    const invalid = (await app.inject({ url: '/admin/subscribers?page=abc&limit=xyz' })).json()
    assert.equal(invalid.page, 1)
    assert.equal(invalid.limit, 25)
    const clamped = (await app.inject({ url: '/admin/subscribers?page=-4&limit=5000' })).json()
    assert.equal(clamped.page, 1)
    assert.equal(clamped.limit, 100)
  })

  it('searches email and webhook URL literally, escaping LIKE wildcards', async () => {
    await addSubscriber({ email: 'alice@example.test' })
    await addSubscriber({ email: 'bob@example.test' })
    await addSubscriber({ email: 'a_b@example.test' })
    await addSubscriber({ type: 'webhook', email: '', webhookUrl: 'https://hooks.example.test/alice' })

    const alice = (await app.inject({ url: '/admin/subscribers?search=alice' })).json()
    assert.equal(alice.total, 2)

    // '_' must not act as a single-character wildcard.
    const underscore = (await app.inject({ url: `/admin/subscribers?search=${encodeURIComponent('a_b')}` })).json()
    assert.deepEqual(underscore.subscribers.map((s: { email: string }) => s.email), ['a_b@example.test'])
    const percent = (await app.inject({ url: `/admin/subscribers?search=${encodeURIComponent('%')}` })).json()
    assert.equal(percent.total, 0)
  })

  it('deletes a subscriber with an audit entry and 404s on unknown ids', async () => {
    const row = await addSubscriber({ email: 'leaving@example.test' })
    assert.equal((await app.inject({ method: 'DELETE', url: '/admin/subscribers/999999' })).statusCode, 404)

    const response = await app.inject({ method: 'DELETE', url: `/admin/subscribers/${row.id}` })
    assert.equal(response.statusCode, 204)
    assert.equal((await db.select().from(subscribers).where(eq(subscribers.id, row.id))).length, 0)
    const audit = (await db.select().from(auditLog).where(eq(auditLog.entityType, 'subscriber')))
      .find((entry) => entry.entityId === String(row.id))
    assert.ok(audit)
    assert.equal(audit.action, 'delete')
    assert.equal(audit.entityName, 'leaving@example.test')
  })
})
