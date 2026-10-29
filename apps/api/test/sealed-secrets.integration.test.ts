import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '../src/db/client.js'
import { actions, monitors, notificationChannels, smtpSettings } from '../src/db/schema.js'
import { createSealer, createSecretBox } from '@better-forge/vault'
import { sealer, secretBox } from '../src/kit/sealer.js'
import { sealStoredSecrets } from '../src/services/sealedColumns.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-sealed-secrets-')

const originalMode = process.env['NODE_ENV']

before(() => {
  process.env['NODE_ENV'] = 'test'
  initTestDb()
})
after(() => {
  if (originalMode === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = originalMode
  teardownTestDb(testDb)
})
beforeEach(() => sqlite.exec('DELETE FROM monitors; DELETE FROM actions; DELETE FROM notification_channels; DELETE FROM smtp_settings'))

const raw = (table: string, column: string): string => (sqlite.prepare(`SELECT ${column} AS value FROM ${table}`).get() as { value: string }).value

describe('credentials typed into a configuration', () => {
  it('are encrypted in the database and plain to the code that reads them', async () => {
    const config = {
      url: 'https://api.example.test/health',
      headers: { Authorization: 'Bearer abc123', Accept: 'application/json' },
      auth: { type: 'basic', basic: { username: 'svc', password: 'p4ss-monitor' } },
    }
    await db.insert(monitors).values({ name: 'API', type: 'https', config: JSON.stringify(config), createdAt: 1, updatedAt: 1 })

    const stored = raw('monitors', 'config')
    assert.ok(!stored.includes('abc123') && !stored.includes('p4ss-monitor'), 'no secret is left in the clear')
    assert.match(JSON.parse(stored).headers.Authorization, /^enc:v1:/)
    assert.equal(JSON.parse(stored).headers.Accept, 'application/json', 'what is not a secret stays readable')
    assert.equal(JSON.parse(stored).url, config.url)

    const [row] = await db.select().from(monitors)
    assert.deepEqual(JSON.parse(row!.config), config)
  })

  it('are encrypted in channels and actions too, and updates seal again', async () => {
    await db.insert(notificationChannels).values({ name: 'Bot', type: 'telegram', config: JSON.stringify({ botToken: 'bot-token-123456', chatId: '1' }), createdAt: 1, updatedAt: 1 })
    await db.insert(actions).values({ name: 'Hook', config: JSON.stringify({ url: 'https://hook.example.test', headers: { 'X-Api-Key': 'key-777' } }), createdAt: 1, updatedAt: 1 })
    assert.ok(!raw('notification_channels', 'config').includes('bot-token-123456'))
    assert.ok(!raw('actions', 'config').includes('key-777'))

    await db.update(notificationChannels).set({ config: JSON.stringify({ botToken: 'rotated-token-9999', chatId: '1' }) })
    assert.ok(!raw('notification_channels', 'config').includes('rotated-token-9999'))
    const [channel] = await db.select().from(notificationChannels)
    assert.equal(JSON.parse(channel!.config).botToken, 'rotated-token-9999')
  })

  it('include the SMTP password', async () => {
    await db.insert(smtpSettings).values({ id: 1, host: 'smtp.example.test', password: 'smtp-pass', updatedAt: 1 })
    assert.match(raw('smtp_settings', 'password'), /^enc:v1:/)
    assert.equal((await db.select().from(smtpSettings).where(eq(smtpSettings.id, 1)))[0]!.password, 'smtp-pass')
  })

  it('keep a vault reference as it is', async () => {
    const reference = { vault: 'prod', secret: 'sql' }
    await db.insert(monitors).values({ name: 'DB', type: 'sqlserver', config: JSON.stringify({ host: 'db', password: reference }), createdAt: 1, updatedAt: 1 })
    assert.deepEqual(JSON.parse(raw('monitors', 'config')).password, reference)
  })
})

describe('a value that looks sealed', () => {
  it('is not decrypted for whoever typed it', async () => {
    const offered = `enc:v1:${secretBox.encrypt('VAULT-SECRET-VALUE')}`
    await db.insert(monitors).values({ name: 'Probe', type: 'https', config: JSON.stringify({ headers: { Authorization: offered } }), createdAt: 1, updatedAt: 1 })
    const [row] = await db.select().from(monitors)
    assert.equal(JSON.parse(row!.config).headers.Authorization, offered, 'comes back as the text that was typed')
  })

  it('fails to open with another key instead of passing the ciphertext on', () => {
    const other = createSealer(createSecretBox({ env: { VAULT_ENCRYPTION_KEY: 'ab'.repeat(32) } }))
    assert.throws(() => sealer.open(other.seal('secret')))
  })
})

describe('upgrading a database that keeps them in the clear', () => {
  it('does not ask for the key when no row holds a secret', () => {
    sqlite.prepare("INSERT INTO monitors (name, type, config, created_at, updated_at, key) VALUES (?, ?, ?, 1, 1, 'plain')")
      .run('Plain', 'ping', '{ "host": "h" }')
    const env = { key: process.env['VAULT_ENCRYPTION_KEY'], mode: process.env['NODE_ENV'] }
    delete process.env['VAULT_ENCRYPTION_KEY']
    process.env['NODE_ENV'] = 'staging'
    try {
      assert.doesNotThrow(() => sealStoredSecrets(sqlite))
      sqlite.prepare("INSERT INTO monitors (name, type, config, created_at, updated_at, key) VALUES (?, ?, ?, 1, 1, 'secret')")
        .run('Secret', 'postgresql', JSON.stringify({ host: 'db', password: 'legacy-pass' }))
      assert.throws(() => sealStoredSecrets(sqlite), /VAULT_ENCRYPTION_KEY/)
    } finally {
      if (env.key === undefined) delete process.env['VAULT_ENCRYPTION_KEY']; else process.env['VAULT_ENCRYPTION_KEY'] = env.key
      process.env['NODE_ENV'] = env.mode
    }
    assert.equal((sqlite.prepare("SELECT config FROM monitors WHERE name = 'Plain'").get() as { config: string }).config, '{ "host": "h" }')
  })

  it('encrypts every row once and leaves the rest untouched', async () => {
    sqlite.prepare('INSERT INTO monitors (name, type, config, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run('Old', 'postgresql', JSON.stringify({ host: 'db', password: 'legacy-pass' }))
    sqlite.prepare('INSERT INTO smtp_settings (id, host, password, updated_at) VALUES (1, ?, ?, 1)').run('smtp', 'legacy-smtp')

    const [before] = await db.select().from(monitors)
    assert.equal(JSON.parse(before!.config).password, 'legacy-pass', 'rows from before are still read')

    sealStoredSecrets(sqlite)
    const sealedOnce = [raw('monitors', 'config'), raw('smtp_settings', 'password')]
    assert.ok(sealedOnce.every((value) => !value.includes('legacy')))
    assert.equal(JSON.parse((await db.select().from(monitors))[0]!.config).password, 'legacy-pass')
    assert.equal((await db.select().from(smtpSettings))[0]!.password, 'legacy-smtp')

    sealStoredSecrets(sqlite)
    assert.deepEqual([raw('monitors', 'config'), raw('smtp_settings', 'password')], sealedOnce, 'a second run changes nothing')
  })
})
