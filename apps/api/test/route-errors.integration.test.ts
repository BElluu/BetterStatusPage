import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db, initDb, sqlite } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { auditLog, monitors, notificationDeliveries, smtpSettings, vaultSecrets } from '../src/db/schema.js'
import { vaultRoutes } from '../src/routes/vaults.js'
import { monitorRoutes } from '../src/routes/monitors.js'
import { notificationRoutes } from '../src/routes/notifications.js'

const dataDir = mkdtempSync(join(tmpdir(), 'bsp-route-errors-test-'))
process.env['DATABASE_PATH'] = join(dataDir, 'test.sqlite')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

const app = Fastify({ logger: false })
const MISSING = 987_654

before(async () => {
  initDb()
  runMigrations()
  app.addHook('preHandler', async (request) => {
    request.user = { userId: 1, email: 'admin@example.test', role: 'admin' }
  })
  await app.register(vaultRoutes, { prefix: '/vaults' })
  await app.register(monitorRoutes, { prefix: '/monitors' })
  await app.register(notificationRoutes, { prefix: '/notifications' })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

async function createMonitor(name: string, type = 'https') {
  const response = await app.inject({ method: 'POST', url: '/monitors', payload: { name, type, config: { url: 'http://127.0.0.1:1' } } })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as { id: number; webhookToken: string | null; failureThreshold: number; recoveryThreshold: number }
}

describe('vault routes', () => {
  let vaultId = 0

  before(async () => {
    vaultId = (await app.inject({ method: 'POST', url: '/vaults', payload: { name: 'Errors' } })).json().id
  })

  it('requires a vault name', async () => {
    for (const name of ['', '   ']) {
      const response = await app.inject({ method: 'POST', url: '/vaults', payload: { name } })
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().error, 'Name is required')
    }
  })

  it('returns 404 for every operation on an unknown vault', async () => {
    const calls = [
      { method: 'PATCH' as const, url: `/vaults/${MISSING}`, payload: { name: 'x' } },
      { method: 'DELETE' as const, url: `/vaults/${MISSING}` },
      { method: 'GET' as const, url: `/vaults/${MISSING}/secrets` },
      { method: 'POST' as const, url: `/vaults/${MISSING}/secrets`, payload: { name: 'x', type: 'value', value: 'v' } },
    ]
    for (const call of calls) {
      const response = await app.inject(call)
      assert.equal(response.statusCode, 404, `${call.method} ${call.url}`)
      assert.equal(response.json().error, 'Vault not found')
    }
  })

  it('validates secret name, type and payload shape', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: ' ', type: 'value', value: 'v' }, /Name is required/],
      [{ name: 'x', type: 'certificate', value: 'v' }, /Type must be one of: userpass, value, json/],
      [{ name: 'x', type: 'userpass' }, /userpass requires username and password/],
      [{ name: 'x', type: 'value' }, /value is required/],
      [{ name: 'x', type: 'json' }, /json is required/],
      [{ name: 'x', type: 'json', json: '{broken' }, /JSON/],
    ]
    for (const [payload, error] of cases) {
      const response = await app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload })
      assert.equal(response.statusCode, 400, JSON.stringify(payload))
      assert.match(response.json().error, error)
    }
    const listed = await app.inject({ url: `/vaults/${vaultId}/secrets` })
    assert.deepEqual(listed.json(), [])
  })

  it('never stores two secrets with the same name in one vault', async () => {
    const first = (await app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload: { name: 'db', type: 'value', value: '1' } })).json()
    const second = (await app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload: { name: 'cache', type: 'value', value: '2' } })).json()
    assert.equal(first.encryptedValue, undefined)

    const duplicate = await app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload: { name: ' db ', type: 'value', value: '3' } })
    assert.ok(duplicate.statusCode >= 400)
    const rename = await app.inject({ method: 'PATCH', url: `/vaults/${vaultId}/secrets/${second.id}`, payload: { name: 'db' } })
    assert.ok(rename.statusCode >= 400)
    const names = (await app.inject({ url: `/vaults/${vaultId}/secrets` })).json().map((s: { name: string }) => s.name)
    assert.deepEqual(names.sort(), ['cache', 'db'])
  })

  // Drizzle wraps the SQLite error as "Failed query: …" with the constraint text on `cause`; the
  // route must still map it to 409 instead of echoing the SQL (and the secret's ciphertext).
  it('rejects duplicate secret names on create and rename with 409', async () => {
    const created = (await app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload: { name: 'dup-a', type: 'value', value: '1' } })).json()
    await app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload: { name: 'dup-b', type: 'value', value: '2' } })
    const duplicate = await app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload: { name: 'dup-b', type: 'value', value: '3' } })
    assert.equal(duplicate.statusCode, 409)
    assert.doesNotMatch(duplicate.body, /Failed query/)
    const rename = await app.inject({ method: 'PATCH', url: `/vaults/${vaultId}/secrets/${created.id}`, payload: { name: 'dup-b' } })
    assert.equal(rename.statusCode, 409)
  })

  it('validates secret updates against the stored type and scopes secrets to their vault', async () => {
    const secret = (await app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload: { name: 'cfg', type: 'json', json: '{"a":1}' } })).json()
    const bad = await app.inject({ method: 'PATCH', url: `/vaults/${vaultId}/secrets/${secret.id}`, payload: { json: 'nope' } })
    assert.equal(bad.statusCode, 400)

    const otherVault = (await app.inject({ method: 'POST', url: '/vaults', payload: { name: 'Other' } })).json()
    for (const call of [
      { method: 'PATCH' as const, url: `/vaults/${otherVault.id}/secrets/${secret.id}`, payload: { name: 'stolen' } },
      { method: 'DELETE' as const, url: `/vaults/${otherVault.id}/secrets/${secret.id}` },
      { method: 'GET' as const, url: `/vaults/${otherVault.id}/secrets/${secret.id}/reveal` },
      { method: 'GET' as const, url: `/vaults/${vaultId}/secrets/${MISSING}/reveal` },
    ]) {
      const response = await app.inject(call)
      assert.equal(response.statusCode, 404, `${call.method} ${call.url}`)
      assert.equal(response.json().error, 'Secret not found')
    }
    const revealed = await app.inject({ url: `/vaults/${vaultId}/secrets/${secret.id}/reveal` })
    assert.deepEqual(revealed.json().value, { value: '{"a":1}' })
  })

  it('answers 500 without leaking details when a secret cannot be decrypted', async () => {
    const [row] = await db.insert(vaultSecrets).values({
      vaultId, name: 'corrupt', type: 'value', encryptedValue: 'garbage', createdAt: 1, updatedAt: 1,
    }).returning()
    const response = await app.inject({ url: `/vaults/${vaultId}/secrets/${row!.id}/reveal` })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), { error: 'Failed to decrypt secret' })
  })

  it('deletes a vault together with its secrets', async () => {
    const vault = (await app.inject({ method: 'POST', url: '/vaults', payload: { name: 'Doomed', description: '  temp  ' } })).json()
    assert.equal(vault.description, 'temp')
    await app.inject({ method: 'POST', url: `/vaults/${vault.id}/secrets`, payload: { name: 's', type: 'value', value: 'v' } })
    assert.equal((await app.inject({ method: 'DELETE', url: `/vaults/${vault.id}` })).statusCode, 204)
    assert.equal((await db.select().from(vaultSecrets).where(eq(vaultSecrets.vaultId, vault.id))).length, 0)
  })
})

describe('monitor routes', () => {
  it('returns 404 for unknown monitors', async () => {
    for (const call of [
      { method: 'GET' as const, url: `/monitors/${MISSING}` },
      { method: 'PATCH' as const, url: `/monitors/${MISSING}`, payload: { name: 'x' } },
      { method: 'POST' as const, url: `/monitors/${MISSING}/check-now` },
      { method: 'POST' as const, url: `/monitors/${MISSING}/reset-token` },
      { method: 'PUT' as const, url: `/monitors/${MISSING}/dependencies`, payload: { dependsOnIds: [] } },
    ]) {
      const response = await app.inject(call)
      assert.equal(response.statusCode, 404, `${call.method} ${call.url}`)
    }
  })

  it('treats deleting an unknown monitor as a no-op without an audit entry', async () => {
    const before = (await db.select().from(auditLog).where(eq(auditLog.entityType, 'monitor'))).length
    assert.equal((await app.inject({ method: 'DELETE', url: `/monitors/${MISSING}` })).statusCode, 204)
    assert.equal((await db.select().from(auditLog).where(eq(auditLog.entityType, 'monitor'))).length, before)
  })

  it('clamps alert thresholds to 1–20 consecutive checks', async () => {
    const created = (await app.inject({
      method: 'POST', url: '/monitors',
      payload: { name: 'thresholds', type: 'https', config: {}, failureThreshold: 0, recoveryThreshold: 999 },
    })).json()
    assert.equal(created.failureThreshold, 1)
    assert.equal(created.recoveryThreshold, 20)
    const patched = (await app.inject({ method: 'PATCH', url: `/monitors/${created.id}`, payload: { failureThreshold: 3.6, recoveryThreshold: -5 } })).json()
    assert.equal(patched.failureThreshold, 4)
    assert.equal(patched.recoveryThreshold, 1)
  })

  it('only rotates tokens for webhook monitors', async () => {
    const https = await createMonitor('not-a-webhook')
    const refused = await app.inject({ method: 'POST', url: `/monitors/${https.id}/reset-token` })
    assert.equal(refused.statusCode, 400)
    assert.equal(refused.json().error, 'Only webhook monitors have tokens')

    const webhook = await createMonitor('push', 'webhook')
    assert.match(webhook.webhookToken ?? '', /^[0-9a-f]{48}$/)
    const rotated = await app.inject({ method: 'POST', url: `/monitors/${webhook.id}/reset-token` })
    assert.equal(rotated.statusCode, 200)
    assert.match(rotated.json().webhookToken, /^[0-9a-f]{48}$/)
    assert.notEqual(rotated.json().webhookToken, webhook.webhookToken)
  })

  it('ignores self-references and unknown ids when saving dependencies', async () => {
    const app1 = await createMonitor('app')
    const database = await createMonitor('database')
    const response = await app.inject({
      method: 'PUT', url: `/monitors/${app1.id}/dependencies`,
      payload: { dependsOnIds: [app1.id, database.id, MISSING] },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual((await app.inject({ url: `/monitors/${app1.id}/dependencies` })).json(), { dependsOnIds: [database.id] })

    // Saving again replaces the previous set rather than appending to it.
    await app.inject({ method: 'PUT', url: `/monitors/${app1.id}/dependencies`, payload: { dependsOnIds: [] } })
    assert.deepEqual((await app.inject({ url: `/monitors/${app1.id}/dependencies` })).json(), { dependsOnIds: [] })
  })

  it('drops dependencies when the monitor they point to is deleted', async () => {
    const web = await createMonitor('web')
    const cache = await createMonitor('cache')
    await app.inject({ method: 'PUT', url: `/monitors/${web.id}/dependencies`, payload: { dependsOnIds: [cache.id] } })
    await app.inject({ method: 'DELETE', url: `/monitors/${cache.id}` })
    assert.deepEqual((await app.inject({ url: `/monitors/${web.id}/dependencies` })).json(), { dependsOnIds: [] })
  })

  it('rejects test runs for monitor types without a tester', async () => {
    for (const type of ['webhook', 'unknown']) {
      const response = await app.inject({ method: 'POST', url: '/monitors/test', payload: { type, config: {} } })
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().error, `Test not supported for monitor type: ${type}`)
    }
  })

  it('validates test run input', async () => {
    for (const payload of [{ type: 'ping', config: [] }, { type: 'ping', config: 'x' }, { type: 'ping', config: {}, timeoutMs: 'soon' }]) {
      const response = await app.inject({ method: 'POST', url: '/monitors/test', payload })
      assert.equal(response.statusCode, 400, JSON.stringify(payload))
    }
  })

  it('requires a name and a known type when creating a monitor', async () => {
    for (const payload of [{ type: 'https', config: {} }, { name: '', type: 'https', config: {} }, { name: 'X', type: 'ftp', config: {} }]) {
      const response = await app.inject({ method: 'POST', url: '/monitors', payload })
      assert.equal(response.statusCode, 400, JSON.stringify(payload))
    }
  })

  it('returns history only for the requested monitor and window', async () => {
    const monitor = await createMonitor('history')
    const other = await createMonitor('other-history')
    const now = Date.now()
    sqlite.prepare('INSERT INTO monitor_results(monitor_id,status,response_ms,checked_at) VALUES (?,?,?,?)').run(monitor.id, 'up', 10, now - 60_000)
    sqlite.prepare('INSERT INTO monitor_results(monitor_id,status,response_ms,checked_at) VALUES (?,?,?,?)').run(monitor.id, 'down', null, now - 3 * 86_400_000)
    sqlite.prepare('INSERT INTO monitor_results(monitor_id,status,response_ms,checked_at) VALUES (?,?,?,?)').run(other.id, 'up', 5, now - 60_000)

    const lastDay = (await app.inject({ url: `/monitors/${monitor.id}/history?days=1` })).json()
    assert.deepEqual(lastDay.map((r: { status: string }) => r.status), ['up'])
    const week = (await app.inject({ url: `/monitors/${monitor.id}/history?days=7` })).json()
    assert.deepEqual(week.map((r: { status: string }) => r.status), ['up', 'down'])
  })
})

describe('notification routes', () => {
  async function addDelivery(status: string): Promise<number> {
    const [row] = await db.insert(notificationDeliveries).values({
      channelId: 1, channelName: 'Ops', channelType: 'webhook', monitorId: null, monitorName: 'API', eventType: 'status_change',
      status, targetStatus: 'down', previousStatus: 'up', variables: '{}', createdAt: Date.now(), updatedAt: Date.now(),
    }).returning()
    return row!.id
  }

  it('returns 404 for unknown deliveries and channels', async () => {
    for (const call of [
      { method: 'GET' as const, url: `/notifications/deliveries/${MISSING}`, error: 'Delivery not found' },
      { method: 'POST' as const, url: `/notifications/deliveries/${MISSING}/retry`, error: 'Delivery not found' },
      { method: 'GET' as const, url: `/notifications/channels/${MISSING}`, error: 'Not found' },
      { method: 'PATCH' as const, url: `/notifications/channels/${MISSING}`, payload: { name: 'x' }, error: 'Not found' },
    ]) {
      const response = await app.inject(call)
      assert.equal(response.statusCode, 404, `${call.method} ${call.url}`)
      assert.equal(response.json().error, call.error)
    }
    const test = await app.inject({ method: 'POST', url: `/notifications/channels/${MISSING}/test` })
    assert.equal(test.statusCode, 422)
    assert.equal(test.json().error, 'Channel not found')
  })

  it('only retries failed deliveries', async () => {
    for (const status of ['pending', 'delivered', 'suppressed']) {
      const id = await addDelivery(status)
      const response = await app.inject({ method: 'POST', url: `/notifications/deliveries/${id}/retry` })
      assert.equal(response.statusCode, 409, status)
      assert.equal(response.json().error, 'Only failed deliveries can be retried')
    }
  })

  it('hides stored variables from the delivery detail', async () => {
    const id = await addDelivery('delivered')
    const detail = await app.inject({ url: `/notifications/deliveries/${id}` })
    assert.equal(detail.statusCode, 200)
    assert.equal('variables' in detail.json(), false)
    assert.deepEqual(detail.json().attempts, [])
  })

  it('paginates the delivery log and clamps the page size', async () => {
    const response = await app.inject({ url: '/notifications/deliveries?limit=500&page=0' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().limit, 100)
    assert.equal(response.json().page, 1)
  })

  // `?page=abc` must not turn into a NaN OFFSET/LIMIT.
  it('falls back to defaults for non-numeric paging', async () => {
    const response = await app.inject({ url: '/notifications/deliveries?page=abc&limit=xyz' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().page, 1)
    assert.equal(response.json().limit, 25)
  })

  it('requires a recipient for the SMTP test', async () => {
    const response = await app.inject({ method: 'POST', url: '/notifications/smtp/test', payload: { to: '' } })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'Recipient address required')
  })

  it('never returns the SMTP password and keeps it when the mask is sent back', async () => {
    const base = { host: 'smtp.example.test', port: 587, secure: 0, user: 'mailer', fromAddress: 'a@example.test', fromName: 'BSP' }
    await app.inject({ method: 'PUT', url: '/notifications/smtp', payload: { ...base, password: 'hunter2' } })
    const shown = (await app.inject({ url: '/notifications/smtp' })).json()
    assert.equal(shown.password, '••••••••')
    assert.equal(shown.vault, null)

    await app.inject({ method: 'PUT', url: '/notifications/smtp', payload: { ...base, port: 2525, password: '••••••••' } })
    let row = (await db.select().from(smtpSettings))[0]!
    assert.equal(row.password, 'hunter2')
    assert.equal(row.port, 2525)

    // Switching to vault credentials wipes the stored ones.
    await app.inject({ method: 'PUT', url: '/notifications/smtp', payload: { ...base, password: 'ignored', vault: { vaultId: 1, secretId: 2 } } })
    row = (await db.select().from(smtpSettings))[0]!
    assert.equal(row.password, '')
    assert.equal(row.user, '')
    assert.deepEqual((await app.inject({ url: '/notifications/smtp' })).json().vault, { vaultId: 1, secretId: 2 })

    const audit = await db.select().from(auditLog).where(eq(auditLog.entityType, 'smtp_settings'))
    assert.deepEqual(audit.map((entry) => entry.action), ['create', 'update', 'update'])
    assert.ok(audit.every((entry) => !(entry.diff ?? '').includes('hunter2')))
  })

  it('replaces monitor channel links and unlinks a deleted channel', async () => {
    const monitor = (await db.insert(monitors).values({
      name: 'linked', type: 'https', config: '{}', createdAt: 1, updatedAt: 1,
    }).returning())[0]!
    const a = (await app.inject({ method: 'POST', url: '/notifications/channels', payload: { name: 'A', type: 'webhook', config: {} } })).json()
    const b = (await app.inject({ method: 'POST', url: '/notifications/channels', payload: { name: 'B', type: 'webhook', config: {} } })).json()

    await app.inject({ method: 'PUT', url: `/notifications/monitor/${monitor.id}/channels`, payload: { channelIds: [a.id, b.id] } })
    assert.deepEqual((await app.inject({ url: `/notifications/monitor/${monitor.id}/channels` })).json().sort(), [a.id, b.id].sort())
    await app.inject({ method: 'PUT', url: `/notifications/monitor/${monitor.id}/channels`, payload: { channelIds: [b.id] } })
    assert.deepEqual((await app.inject({ url: `/notifications/monitor/${monitor.id}/channels` })).json(), [b.id])

    assert.equal((await app.inject({ method: 'DELETE', url: `/notifications/channels/${b.id}` })).statusCode, 204)
    assert.deepEqual((await app.inject({ url: `/notifications/monitor/${monitor.id}/channels` })).json(), [])
  })

  // A duplicate id would violate the (monitor_id, channel_id) primary key after the old links were
  // deleted, leaving the monitor with no channels.
  it('tolerates duplicate channel ids', async () => {
    const monitor = (await db.insert(monitors).values({ name: 'dupes', type: 'https', config: '{}', createdAt: 1, updatedAt: 1 }).returning())[0]!
    const c = (await app.inject({ method: 'POST', url: '/notifications/channels', payload: { name: 'C', type: 'webhook', config: {} } })).json()
    const response = await app.inject({ method: 'PUT', url: `/notifications/monitor/${monitor.id}/channels`, payload: { channelIds: [c.id, c.id] } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual((await app.inject({ url: `/notifications/monitor/${monitor.id}/channels` })).json(), [c.id])
  })

  it('keeps existing channel links when the new set is invalid', async () => {
    const monitor = (await db.insert(monitors).values({ name: 'kept', type: 'https', config: '{}', createdAt: 1, updatedAt: 1 }).returning())[0]!
    const c = (await app.inject({ method: 'POST', url: '/notifications/channels', payload: { name: 'K', type: 'webhook', config: {} } })).json()
    await app.inject({ method: 'PUT', url: `/notifications/monitor/${monitor.id}/channels`, payload: { channelIds: [c.id] } })

    for (const channelIds of [undefined, 'x', [c.id, 'x'], [0]]) {
      const response = await app.inject({ method: 'PUT', url: `/notifications/monitor/${monitor.id}/channels`, payload: { channelIds } })
      assert.equal(response.statusCode, 400, JSON.stringify(channelIds))
    }
    const unknown = await app.inject({ method: 'PUT', url: `/notifications/monitor/${monitor.id}/channels`, payload: { channelIds: [c.id, 999_999] } })
    assert.equal(unknown.statusCode, 400)
    assert.deepEqual((await app.inject({ url: `/notifications/monitor/${monitor.id}/channels` })).json(), [c.id])
  })

  it('requires a name and a known type when creating a channel', async () => {
    for (const payload of [{ type: 'webhook', config: {} }, { name: '  ', type: 'webhook', config: {} }, { name: 'X', type: 'pager', config: {} }]) {
      const response = await app.inject({ method: 'POST', url: '/notifications/channels', payload })
      assert.equal(response.statusCode, 400, JSON.stringify(payload))
    }
  })
})
