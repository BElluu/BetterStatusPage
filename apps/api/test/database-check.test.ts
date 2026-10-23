import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { db } from '../src/db/client.js'
import { vaults, vaultSecrets } from '../src/db/schema.js'
import { encrypt } from '../src/kit/secretBox.js'
import {
  checkDatabase, firstValue, resolveConnectionString, resolveFieldCredentials,
  type DatabaseConnection, type DatabaseDriver, type DatabaseSession,
} from '../src/workers/database.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-database-check-test-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

let vaultId = 0

async function addSecret(name: string, type: string, payload: unknown): Promise<number> {
  const [row] = await db.insert(vaultSecrets).values({
    vaultId, name, type, encryptedValue: encrypt(JSON.stringify(payload)), createdAt: Date.now(), updatedAt: Date.now(),
  }).returning()
  return row!.id
}

before(async () => {
  initTestDb()
  const [vault] = await db.insert(vaults).values({ name: 'Primary', type: 'local', createdAt: Date.now(), updatedAt: Date.now() }).returning()
  vaultId = vault!.id
})

after(() => teardownTestDb(testDb))

interface FakeOptions {
  rows?: unknown[][]
  connectError?: Error
  queryError?: unknown
}

/** A driver that records what the shared check flow asked of it. */
function fakeDriver({ rows = [[1]], connectError, queryError }: FakeOptions = {}) {
  const calls = { connections: [] as DatabaseConnection[], timeouts: [] as number[], queries: [] as string[], closed: 0 }
  const driver: DatabaseDriver = {
    label: 'Fake DB',
    defaultQuery: 'SELECT default',
    async connect(connection, timeoutMs) {
      calls.connections.push(connection)
      calls.timeouts.push(timeoutMs)
      if (connectError) throw connectError
      const session: DatabaseSession = {
        async query(sql) {
          calls.queries.push(sql)
          if (queryError) throw queryError
          return rows
        },
        async close() { calls.closed++ },
      }
      return session
    },
  }
  return { driver, calls }
}

const base = { host: 'db', port: 5432, database: 'd', user: 'u', password: 'pw', query: 'SELECT 1' }

describe('firstValue', () => {
  it('returns the first column of the first row as text', () => {
    assert.equal(firstValue([[42, 'x'], ['y']]), '42')
    assert.equal(firstValue([['ok']]), 'ok')
  })

  it('returns null for an empty result', () => {
    assert.equal(firstValue([]), null)
  })

  it('stringifies falsy values instead of treating them as empty', () => {
    assert.equal(firstValue([[0]]), '0')
    assert.equal(firstValue([[false]]), 'false')
    assert.equal(firstValue([['']]), '')
  })
})

describe('resolveFieldCredentials', () => {
  it('uses the config credentials without a vault', async () => {
    assert.deepEqual(await resolveFieldCredentials(base), { user: 'u', password: 'pw' })
  })

  it('takes username and password from a userpass secret', async () => {
    const secretId = await addSecret('userpass', 'userpass', { username: 'vault-u', password: 'vault-pw' })
    assert.deepEqual(await resolveFieldCredentials({ ...base, vault: { vaultId, secretId } }), { user: 'vault-u', password: 'vault-pw' })
  })

  it('accepts user and value keys from a json secret', async () => {
    const secretId = await addSecret('json-creds', 'json', { value: JSON.stringify({ user: 'json-u', value: 'json-pw' }) })
    assert.deepEqual(await resolveFieldCredentials({ ...base, vault: { vaultId, secretId } }), { user: 'json-u', password: 'json-pw' })
  })

  it('keeps the config value for a field the secret does not provide', async () => {
    const secretId = await addSecret('password-only', 'json', { value: JSON.stringify({ password: 'only-pw' }) })
    assert.deepEqual(await resolveFieldCredentials({ ...base, vault: { vaultId, secretId } }), { user: 'u', password: 'only-pw' })
  })
})

describe('resolveConnectionString', () => {
  const { driver } = fakeDriver()

  it('reads the connectionString key, falling back to value', async () => {
    const named = await addSecret('conn-named', 'json', { value: JSON.stringify({ connectionString: 'db://named', value: 'db://other' }) })
    const plain = await addSecret('conn-value', 'value', { value: 'db://plain' })
    assert.equal(await resolveConnectionString(driver, { vaultId, secretId: named }), 'db://named')
    assert.equal(await resolveConnectionString(driver, { vaultId, secretId: plain }), 'db://plain')
  })

  it('names the engine when the secret is empty', async () => {
    const secretId = await addSecret('conn-empty', 'value', { value: '' })
    await assert.rejects(() => resolveConnectionString(driver, { vaultId, secretId }), /Fake DB: resolved connection string is empty/)
  })
})

describe('checkDatabase', () => {
  it('is up, passes fields and timeout to the driver and closes the session', async () => {
    const { driver, calls } = fakeDriver()
    const result = await checkDatabase(driver, base, 1_234)
    assert.deepEqual({ status: result.status, error: result.error }, { status: 'up', error: null })
    assert.equal(typeof result.responseMs, 'number')
    assert.deepEqual(calls.connections, [
      { host: 'db', port: 5432, database: 'd', user: 'u', password: 'pw', tls: 'prefer' },
    ])
    assert.deepEqual(calls.timeouts, [1_234])
    assert.deepEqual(calls.queries, ['SELECT 1'])
    assert.equal(calls.closed, 1)
  })

  it('runs the engine default query when the config has none', async () => {
    const { driver, calls } = fakeDriver()
    await checkDatabase(driver, { ...base, query: '' }, 500)
    assert.deepEqual(calls.queries, ['SELECT default'])
  })

  it('uses the vault credentials in fields mode', async () => {
    const secretId = await addSecret('check-creds', 'userpass', { username: 'vault-u', password: 'vault-pw' })
    const { driver, calls } = fakeDriver()
    await checkDatabase(driver, { ...base, vault: { vaultId, secretId } }, 500)
    assert.deepEqual(calls.connections[0], { host: 'db', port: 5432, database: 'd', user: 'vault-u', password: 'vault-pw', tls: 'prefer' })
  })

  it('passes the vault connection string in connectionString mode', async () => {
    const secretId = await addSecret('check-conn', 'value', { value: 'db://from-vault' })
    const { driver, calls } = fakeDriver()
    const result = await checkDatabase(driver, { ...base, mode: 'connectionString', vault: { vaultId, secretId } }, 500)
    assert.equal(result.status, 'up')
    assert.deepEqual(calls.connections, [{ connectionString: 'db://from-vault' }])
  })

  it('requires a vault secret in connectionString mode without connecting', async () => {
    const { driver, calls } = fakeDriver()
    const result = await checkDatabase(driver, { ...base, mode: 'connectionString' }, 500)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'Fake DB connection string mode requires a vault secret')
    assert.equal(calls.connections.length, 0)
  })

  it('is up when the first value equals the expected result', async () => {
    const { driver } = fakeDriver({ rows: [[7], [8]] })
    const result = await checkDatabase(driver, { ...base, expectedResult: '7' }, 500)
    assert.deepEqual({ status: result.status, error: result.error }, { status: 'up', error: null })
  })

  it('is degraded with the actual value when it differs from the expected result', async () => {
    const { driver } = fakeDriver({ rows: [['bad']] })
    const result = await checkDatabase(driver, { ...base, expectedResult: 'good' }, 500)
    assert.equal(result.status, 'degraded')
    assert.equal(result.error, 'Expected "good", got "bad"')
    assert.equal(typeof result.responseMs, 'number')
  })

  it('is degraded for an empty result when a value is expected', async () => {
    const { driver } = fakeDriver({ rows: [] })
    const result = await checkDatabase(driver, { ...base, expectedResult: 'good' }, 500)
    assert.equal(result.status, 'degraded')
    assert.equal(result.error, 'Expected "good", got ""')
  })

  it('does not compare anything when no result is expected', async () => {
    const { driver } = fakeDriver({ rows: [] })
    assert.equal((await checkDatabase(driver, base, 500)).status, 'up')
  })

  it('is down with the connect error and has no session to close', async () => {
    const { driver, calls } = fakeDriver({ connectError: new Error('connection refused') })
    const result = await checkDatabase(driver, base, 500)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'connection refused')
    assert.equal(typeof result.responseMs, 'number')
    assert.equal(calls.closed, 0)
  })

  it('is down on a query error and still closes the session', async () => {
    const { driver, calls } = fakeDriver({ queryError: new Error('syntax error') })
    const result = await checkDatabase(driver, base, 500)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'syntax error')
    assert.equal(calls.closed, 1)
  })

  it('stringifies a non-Error rejection', async () => {
    const { driver } = fakeDriver({ queryError: 'plain failure' })
    const result = await checkDatabase(driver, base, 500)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'plain failure')
  })

  it('is down for an unknown TLS mode before connecting', async () => {
    const { driver, calls } = fakeDriver()
    const result = await checkDatabase(driver, { ...base, tls: 'off' as never }, 500)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /Unknown TLS mode "off"/)
    assert.equal(calls.connections.length, 0)
  })

  it('reports a missing vault secret as down', async () => {
    const { driver, calls } = fakeDriver()
    const result = await checkDatabase(driver, { ...base, vault: { vaultId, secretId: 424_242 } }, 500)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /Vault secret 424242 not found/)
    assert.equal(calls.connections.length, 0)
  })
})
