import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { auditLog, vaults, vaultSecrets } from '../src/db/schema.js'
import { vaultCatalogRoutes, vaultRoutes } from '../src/routes/vaults.js'
import { resolveVaultSecret } from '../src/workers/resolveSecret.js'
import { forgetHashicorpVault, hashicorpLimits } from '../src/services/hashicorpVault.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-hashicorp-vault-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

const TOKEN = 's.static-token-value'
const ROLE_ID = 'role-id-value'
const SECRET_ID = 'secret-id-value'
const CLIENT_TOKEN = 's.client-token-from-login'

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let seen: Seen[] = []
let logins = 0
let leaseSeconds = 3600
let behaviour: 'ok' | 'redirect' | 'hang' | 'huge' | 'forbid-once' = 'ok'
let forbidden = false
const redirectTargetHits: Seen[] = []

const KV: Record<string, Record<string, unknown>> = {
  'bsp/db': { username: 'svc', password: 'pw-from-vault', api_key: 'k-123', client_id: 'cid', client_secret: 'csec' },
}

const vaultServer = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() }
    seen.push(entry)
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
    if (behaviour === 'hang') return
    if (behaviour === 'redirect') { res.writeHead(307, { location: `http://127.0.0.1:${redirectPort}/steal` }); return res.end() }
    if (behaviour === 'huge') { res.writeHead(200); return res.end('x'.repeat(2 * 1024 * 1024)) }
    if (req.url?.startsWith('/v1/auth/approle/login')) {
      logins++
      const body = JSON.parse(entry.body) as { role_id: string; secret_id: string }
      if (body.role_id !== ROLE_ID || body.secret_id !== SECRET_ID) return send(400, { errors: ['invalid role or secret ID'] })
      return send(200, { auth: { client_token: CLIENT_TOKEN, lease_duration: leaseSeconds } })
    }
    if (req.url === '/v1/auth/token/lookup-self') {
      return req.headers['x-vault-token'] === TOKEN ? send(200, { data: { ttl: 900 } }) : send(403, { errors: ['permission denied'] })
    }
    const token = req.headers['x-vault-token']
    if (token !== TOKEN && token !== CLIENT_TOKEN) return send(403, { errors: ['permission denied'] })
    if (behaviour === 'forbid-once' && !forbidden) { forbidden = true; return send(403, { errors: ['permission denied'] }) }
    const match = /^\/v1\/secret\/data\/(.+)$/.exec(req.url ?? '')
    const data = match ? KV[match[1]!] : undefined
    if (!data) return send(404, { errors: [] })
    send(200, { data: { data, metadata: { version: 1 } } })
  })
})

let redirectPort = 0
const redirectServer = http.createServer((req, res) => {
  redirectTargetHits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' })
  res.end('{}')
})

const app = Fastify({ logger: false })
let address = ''

type Connection = Record<string, unknown>
const tokenConnection = (extra: Connection = {}): Connection => ({ address, mount: 'secret', authMethod: 'token', token: TOKEN, ...extra })
const approleConnection = (extra: Connection = {}): Connection => ({ address, mount: 'secret', authMethod: 'approle', roleId: ROLE_ID, secretId: SECRET_ID, ...extra })

async function createVault(connection: Connection, name = `HV ${Math.random()}`) {
  const res = await app.inject({ method: 'POST', url: '/vaults', payload: { name, type: 'hashicorp', connection } })
  return res
}

async function addSecret(vaultId: number, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/vaults/${vaultId}/secrets`, payload: body })
}

async function setup(connection: Connection) {
  const res = await createVault(connection)
  assert.equal(res.statusCode, 200, res.body)
  return (res.json() as { id: number }).id
}

before(async () => {
  initTestDb()
  await new Promise<void>((r) => redirectServer.listen(0, '127.0.0.1', r))
  redirectPort = (redirectServer.address() as AddressInfo).port
  await new Promise<void>((r) => vaultServer.listen(0, '127.0.0.1', r))
  address = `http://127.0.0.1:${(vaultServer.address() as AddressInfo).port}`
  app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { userId: 1, email: 'admin@example.test', role: 'admin', sessionId: 's' } })
  await app.register(vaultCatalogRoutes, { prefix: '/catalog' })
  await app.register(vaultRoutes, { prefix: '/vaults' })
  await app.ready()
})

after(async () => {
  await app.close()
  vaultServer.closeAllConnections()
  await new Promise((r) => vaultServer.close(r))
  await new Promise((r) => redirectServer.close(r))
  teardownTestDb(testDb)
})

beforeEach(() => {
  seen = []
  logins = 0
  leaseSeconds = 3600
  behaviour = 'ok'
  forbidden = false
  redirectTargetHits.length = 0
  KV['bsp/db'] = { username: 'svc', password: 'pw-from-vault', api_key: 'k-123', client_id: 'cid', client_secret: 'csec' }
  hashicorpLimits.timeoutMs = 10_000
  hashicorpLimits.freshTokenMs = 10_000
})

describe('connection validation', () => {
  it('rejects bad addresses, paths and missing credentials', async () => {
    const bad: Array<[Connection, RegExp]> = [
      [tokenConnection({ address: 'ftp://vault' }), /http/],
      [tokenConnection({ address: 'http://user:pw@vault:8200' }), /plain URL/],
      [tokenConnection({ address: 'http://vault:8200/v1' }), /plain URL/],
      [tokenConnection({ mount: '../auth' }), /KV mount is invalid/],
      [tokenConnection({ mount: 'a/%2e%2e/b' }), /KV mount is invalid/],
      [tokenConnection({ token: '' }), /Token is required/],
      [approleConnection({ secretId: '' }), /Role ID and Secret ID/],
      [tokenConnection({ caCert: 'not a cert' }), /PEM/],
    ]
    for (const [connection, message] of bad) {
      const res = await createVault(connection)
      assert.equal(res.statusCode, 400, JSON.stringify(connection))
      assert.match((res.json() as { error: string }).error, message)
    }
  })

  it('never returns or audits credentials', async () => {
    const id = await setup(tokenConnection())
    const detail = await app.inject({ method: 'GET', url: `/vaults/${id}` })
    assert.doesNotMatch(detail.body, new RegExp(TOKEN))
    assert.equal((detail.json() as { connection: { hasToken: boolean } }).connection.hasToken, true)
    const catalog = await app.inject({ method: 'GET', url: '/catalog' })
    assert.doesNotMatch(catalog.body, /connectionConfig|connection_config|static-token/)
    await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: tokenConnection({ token: 's.rotated-token' }) } })
    const audit = JSON.stringify(await db.select().from(auditLog))
    assert.doesNotMatch(audit, /static-token|rotated-token/)
    assert.match(audit, /credentials/)
  })

  it('requires credentials again when the address changes, and keeps them otherwise', async () => {
    const id = await setup(tokenConnection())
    const keep = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { name: 'Renamed', connection: tokenConnection({ token: '' }) } })
    assert.equal(keep.statusCode, 200, keep.body)
    assert.doesNotMatch(keep.body, /connectionConfig|connection_config/)
    for (const change of [{ mount: 'kv' }, { caCert: '-----BEGIN CERTIFICATE-----abc-----END CERTIFICATE-----' }]) {
      const res = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: tokenConnection({ token: '', ...change }) } })
      assert.equal(res.statusCode, 400, JSON.stringify(change))
    }
    const moved = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: tokenConnection({ token: '', address: 'http://127.0.0.1:1' }) } })
    assert.equal(moved.statusCode, 400)
    assert.match((moved.json() as { error: string }).error, /Re-enter the token/)
  })

  it('rejects connection settings on a local vault', async () => {
    const [local] = await db.insert(vaults).values({ name: 'Local one', createdAt: 1, updatedAt: 1 }).returning()
    const res = await app.inject({ method: 'PATCH', url: `/vaults/${local!.id}`, payload: { connection: tokenConnection() } })
    assert.equal(res.statusCode, 400)
  })
})

describe('test connection', () => {
  it('reports token TTL, AppRole login and failures', async () => {
    const tokenVault = await setup(tokenConnection())
    const ok = await app.inject({ method: 'POST', url: `/vaults/${tokenVault}/test` })
    assert.deepEqual(ok.json(), { ok: true, authMethod: 'token', ttlSeconds: 900 })
    assert.equal(seen[0]!.headers['x-vault-token'], TOKEN)
    assert.equal(seen[0]!.headers['x-vault-request'], 'true')

    const approleVault = await setup(approleConnection())
    assert.equal((await app.inject({ method: 'POST', url: `/vaults/${approleVault}/test` })).json<{ ok: boolean }>().ok, true)

    const badVault = await setup(tokenConnection({ token: 'wrong' }))
    const bad = await app.inject({ method: 'POST', url: `/vaults/${badVault}/test` })
    assert.equal(bad.statusCode, 502)
    assert.doesNotMatch(bad.body, /wrong/)
  })

  it('reports an unreachable server without leaking the address or token', async () => {
    const id = await setup(tokenConnection({ address: 'http://127.0.0.1:1' }))
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.equal(res.statusCode, 502)
    assert.match((res.json() as { error: string }).error, /cannot connect/)
    assert.doesNotMatch(res.body, new RegExp(TOKEN))
  })

  it('tests unsaved settings, and falls back to saved credentials only for the same target', async () => {
    const draft = await app.inject({ method: 'POST', url: '/vaults/test-connection', payload: { connection: tokenConnection() } })
    assert.deepEqual(draft.json(), { ok: true, authMethod: 'token', ttlSeconds: 900 })
    assert.equal(seen[0]!.headers['x-vault-token'], TOKEN)

    assert.equal((await app.inject({ method: 'POST', url: '/vaults/test-connection', payload: { connection: tokenConnection({ token: 'wrong' }) } })).statusCode, 502)
    assert.equal((await app.inject({ method: 'POST', url: '/vaults/test-connection', payload: { connection: { address: 'nope' } } })).statusCode, 400)

    const id = await setup(tokenConnection())
    const kept = await app.inject({ method: 'POST', url: '/vaults/test-connection', payload: { vaultId: id, connection: tokenConnection({ token: '' }) } })
    assert.equal(kept.json<{ ok: boolean }>().ok, true)
    seen = []
    const moved = await app.inject({ method: 'POST', url: '/vaults/test-connection', payload: { vaultId: id, connection: tokenConnection({ token: '', address: 'http://127.0.0.1:1' }) } })
    assert.equal(moved.statusCode, 400)
    assert.equal(seen.length, 0)
    assert.equal((await app.inject({ method: 'POST', url: '/vaults/test-connection', payload: { vaultId: 99999, connection: tokenConnection() } })).statusCode, 404)
  })

  it('sends the namespace header', async () => {
    const id = await setup(tokenConnection({ namespace: 'team/a' }))
    await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.equal(seen[0]!.headers['x-vault-namespace'], 'team/a')
  })
})

describe('credentials from a local vault', () => {
  async function localSecret(body: Record<string, unknown>) {
    const vault = (await app.inject({ method: 'POST', url: '/vaults', payload: { name: `Local ${Math.random()}` } })).json() as { id: number }
    const secret = await app.inject({ method: 'POST', url: `/vaults/${vault.id}/secrets`, payload: { name: 'bootstrap', ...body } })
    assert.equal(secret.statusCode, 200, secret.body)
    return { vaultId: vault.id, secretId: (secret.json() as { id: number }).id }
  }

  it('reads the token from a Secure Value and never stores or returns it', async () => {
    const ref = await localSecret({ type: 'value', value: TOKEN })
    const id = await setup({ address, mount: 'secret', authMethod: 'token', credentialsRef: ref })
    seen = []
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.deepEqual(res.json(), { ok: true, authMethod: 'token', ttlSeconds: 900 })
    assert.equal(seen[0]!.headers['x-vault-token'], TOKEN)
    const detail = await app.inject({ method: 'GET', url: `/vaults/${id}` })
    assert.doesNotMatch(detail.body, new RegExp(TOKEN))
    assert.deepEqual((detail.json() as { connection: { credentialsRef: unknown } }).connection.credentialsRef, ref)
    const row = (await db.select().from(vaults).where(eq(vaults.id, id)))[0]!
    assert.doesNotMatch(row.connectionConfig!, new RegExp(TOKEN))
  })

  it('reads the Role ID and Secret ID from a User / Password secret', async () => {
    const ref = await localSecret({ type: 'userpass', userpass: { username: ROLE_ID, password: SECRET_ID } })
    const id = await setup({ address, mount: 'secret', authMethod: 'approle', credentialsRef: ref })
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json<{ authMethod: string }>().authMethod, 'approle')
  })

  it('follows a rotation in the local secret and fails clearly when it is deleted', async () => {
    const ref = await localSecret({ type: 'value', value: 'wrong-token' })
    const id = await setup({ address, mount: 'secret', authMethod: 'token', credentialsRef: ref })
    assert.equal((await app.inject({ method: 'POST', url: `/vaults/${id}/test` })).statusCode, 502)
    const fixed = await app.inject({ method: 'PATCH', url: `/vaults/${ref.vaultId}/secrets/${ref.secretId}`, payload: { value: TOKEN } })
    assert.equal(fixed.statusCode, 200, fixed.body)
    assert.equal((await app.inject({ method: 'POST', url: `/vaults/${id}/test` })).statusCode, 200)
    await db.delete(vaultSecrets).where(eq(vaultSecrets.id, ref.secretId))
    const gone = await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.equal(gone.statusCode, 502)
    assert.match((gone.json() as { error: string }).error, /no longer exists in a local vault/)
  })

  it('refuses a missing secret, the wrong type, a HashiCorp vault secret and a bad reference', async () => {
    const wrongType = await localSecret({ type: 'userpass', userpass: { username: 'a', password: 'b' } })
    const refs: Array<[unknown, RegExp]> = [
      [{ vaultId: 99999, secretId: 99999 }, /no longer exists/],
      [wrongType, /Secure Value/],
      [{ vaultId: 'x', secretId: 1 }, /Select a secret/],
    ]
    for (const [credentialsRef, message] of refs) {
      const res = await createVault({ address, mount: 'secret', authMethod: 'token', credentialsRef })
      assert.equal(res.statusCode, 400, JSON.stringify(credentialsRef))
      assert.match((res.json() as { error: string }).error, message)
    }
    const hashicorpSecretVault = await setup(tokenConnection())
    const [hv] = await db.insert(vaultSecrets).values({ vaultId: hashicorpSecretVault, name: 'ref', type: 'value', encryptedValue: 'x', createdAt: 1, updatedAt: 1 }).returning()
    const res = await createVault({ address, mount: 'secret', authMethod: 'token', credentialsRef: { vaultId: hashicorpSecretVault, secretId: hv!.id } })
    assert.equal(res.statusCode, 400)
    assert.match((res.json() as { error: string }).error, /local vault/)
  })

  it('keeps the reference unless direct credentials are sent, and drops it when the target changes', async () => {
    const ref = await localSecret({ type: 'value', value: TOKEN })
    const id = await setup({ address, mount: 'secret', authMethod: 'token', credentialsRef: ref })
    const kept = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: { address, mount: 'secret', authMethod: 'token' } } })
    assert.equal(kept.statusCode, 200, kept.body)
    assert.equal((await app.inject({ method: 'POST', url: `/vaults/${id}/test` })).statusCode, 200)

    const moved = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: { address: 'http://127.0.0.1:1', mount: 'secret', authMethod: 'token' } } })
    assert.equal(moved.statusCode, 400)

    const direct = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: { address, mount: 'secret', authMethod: 'token', token: TOKEN, credentialsRef: null } } })
    assert.equal(direct.statusCode, 200, direct.body)
    assert.equal((await app.inject({ method: 'GET', url: `/vaults/${id}` })).json<{ connection: { credentialsRef: unknown } }>().connection.credentialsRef, null)
  })

  it('reads AppRole credentials and the token from a JSON secret, by default or mapped key names', async () => {
    const byDefault = await localSecret({ type: 'json', json: JSON.stringify({ roleId: ROLE_ID, secretId: SECRET_ID }) })
    const a = await setup({ address, mount: 'secret', authMethod: 'approle', credentialsRef: byDefault })
    assert.equal((await app.inject({ method: 'POST', url: `/vaults/${a}/test` })).statusCode, 200)

    const mapped = await localSecret({ type: 'json', json: JSON.stringify({ role: ROLE_ID, secret: SECRET_ID, tok: TOKEN }) })
    const b = await setup({ address, mount: 'secret', authMethod: 'approle', credentialsRef: { ...mapped, fieldMapping: { roleId: 'role', secretId: 'secret' } } })
    assert.equal((await app.inject({ method: 'POST', url: `/vaults/${b}/test` })).statusCode, 200)
    const detail = await app.inject({ method: 'GET', url: `/vaults/${b}` })
    assert.deepEqual((detail.json() as { connection: { credentialsRef: unknown } }).connection.credentialsRef, { ...mapped, fieldMapping: { roleId: 'role', secretId: 'secret' } })

    const token = await setup({ address, mount: 'secret', authMethod: 'token', credentialsRef: { ...mapped, fieldMapping: { token: 'tok' } } })
    seen = []
    assert.equal((await app.inject({ method: 'POST', url: `/vaults/${token}/test` })).statusCode, 200)
    assert.equal(seen[0]!.headers['x-vault-token'], TOKEN)

    const missing = await createVault({ address, mount: 'secret', authMethod: 'approle', credentialsRef: { ...mapped, fieldMapping: { roleId: 'nope', secretId: 'secret' } } })
    assert.equal(missing.statusCode, 400)
    assert.match((missing.json() as { error: string }).error, /JSON secret with the Role ID and Secret ID keys/)
  })

  it('trims a token read from the secret', async () => {
    const ref = await localSecret({ type: 'value', value: `${TOKEN}
` })
    const id = await setup({ address, mount: 'secret', authMethod: 'token', credentialsRef: ref })
    seen = []
    assert.equal((await app.inject({ method: 'POST', url: `/vaults/${id}/test` })).statusCode, 200)
    assert.equal(seen[0]!.headers['x-vault-token'], TOKEN)
  })

  it('applies a rotated or deleted local secret to an AppRole session straight away', async () => {
    const ref = await localSecret({ type: 'userpass', userpass: { username: ROLE_ID, password: SECRET_ID } })
    const id = await setup({ address, mount: 'secret', authMethod: 'approle', credentialsRef: ref })
    const secret = await addSecret(id, { name: 'db', type: 'userpass', path: 'bsp/db' })
    assert.equal(secret.statusCode, 200, secret.body)
    const secretId = (secret.json() as { id: number }).id
    await resolveVaultSecret({ vaultId: id, secretId }) // logs in and caches the client token

    await app.inject({ method: 'PATCH', url: `/vaults/${ref.vaultId}/secrets/${ref.secretId}`, payload: { userpass: { username: ROLE_ID, password: 'rotated-wrong' } } })
    await assert.rejects(resolveVaultSecret({ vaultId: id, secretId }), /AppRole login was rejected/)

    await app.inject({ method: 'PATCH', url: `/vaults/${ref.vaultId}/secrets/${ref.secretId}`, payload: { userpass: { username: ROLE_ID, password: SECRET_ID } } })
    await resolveVaultSecret({ vaultId: id, secretId })
    await app.inject({ method: 'DELETE', url: `/vaults/${ref.vaultId}/secrets/${ref.secretId}` })
    await assert.rejects(resolveVaultSecret({ vaultId: id, secretId }), /no longer exists in a local vault/)
  })

  it('audits a change of the credentials secret', async () => {
    const first = await localSecret({ type: 'value', value: TOKEN })
    const second = await localSecret({ type: 'value', value: TOKEN })
    const id = await setup({ address, mount: 'secret', authMethod: 'token', credentialsRef: first })
    const before = (await db.select().from(auditLog)).length
    const res = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: { address, mount: 'secret', authMethod: 'token', credentialsRef: second } } })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal((await db.select().from(auditLog)).length, before + 1)
  })

  it('tests an unsaved connection that uses a local secret', async () => {
    const ref = await localSecret({ type: 'value', value: TOKEN })
    const res = await app.inject({ method: 'POST', url: '/vaults/test-connection', payload: { connection: { address, mount: 'secret', authMethod: 'token', credentialsRef: ref } } })
    assert.deepEqual(res.json(), { ok: true, authMethod: 'token', ttlSeconds: 900 })
  })
})

describe('secret references', () => {
  it('maps userpass, value and json secrets and rotates live', async () => {
    const id = await setup(tokenConnection())
    const up = (await addSecret(id, { name: 'db', type: 'userpass', path: 'bsp/db' })).json<{ id: number }>()
    const val = (await addSecret(id, { name: 'key', type: 'value', path: 'bsp/db', key: 'api_key' })).json<{ id: number }>()
    const js = (await addSecret(id, { name: 'oauth', type: 'json', path: '/bsp/db/' })).json<{ id: number }>()

    assert.deepEqual(await resolveVaultSecret({ vaultId: id, secretId: up.id }), { username: 'svc', password: 'pw-from-vault' })
    assert.deepEqual(await resolveVaultSecret({ vaultId: id, secretId: val.id }), { value: 'k-123' })
    assert.deepEqual(
      await resolveVaultSecret({ vaultId: id, secretId: js.id, fieldMapping: { clientId: 'client_id', clientSecret: 'client_secret' } }),
      { clientId: 'cid', clientSecret: 'csec' },
    )

    KV['bsp/db'] = { ...KV['bsp/db']!, password: 'rotated' }
    assert.equal((await resolveVaultSecret({ vaultId: id, secretId: up.id }))['password'], 'rotated')
  })

  it('refuses unknown paths, keys and bad references when creating', async () => {
    const id = await setup(tokenConnection())
    const missing = await addSecret(id, { name: 'a', type: 'userpass', path: 'bsp/nope' })
    assert.equal(missing.statusCode, 400)
    assert.match(missing.json<{ error: string }>().error, /secret not found at secret\/bsp\/nope/)
    const noKey = await addSecret(id, { name: 'b', type: 'value', path: 'bsp/db', key: 'absent' })
    assert.match(noKey.json<{ error: string }>().error, /key "absent" not found/)
    const needsKey = await addSecret(id, { name: 'c', type: 'value', path: 'bsp/db' })
    assert.match(needsKey.json<{ error: string }>().error, /Key is required/)
    const traversal = await addSecret(id, { name: 'd', type: 'userpass', path: 'bsp/../../auth/token/create' })
    assert.equal(traversal.statusCode, 400)
    assert.equal(seen.some((s) => s.url.includes('auth/token/create')), false)
  })

  it('reveals through Vault with the source reference', async () => {
    const id = await setup(tokenConnection())
    const { id: secretId } = (await addSecret(id, { name: 'db', type: 'userpass', path: 'bsp/db' })).json<{ id: number }>()
    const res = await app.inject({ method: 'GET', url: `/vaults/${id}/secrets/${secretId}/reveal` })
    assert.deepEqual(res.json(), {
      id: secretId, name: 'db', type: 'userpass',
      value: { username: 'svc', password: 'pw-from-vault' }, source: { path: 'bsp/db' },
    })
    const [row] = await db.select().from(vaultSecrets).where(eq(vaultSecrets.id, secretId))
    assert.doesNotMatch(row!.encryptedValue, /pw-from-vault/)
  })

  it('names the vault when a use fails', async () => {
    const id = await setup(tokenConnection())
    const { id: secretId } = (await addSecret(id, { name: 'db', type: 'userpass', path: 'bsp/db' })).json<{ id: number }>()
    const original = KV['bsp/db']!
    delete KV['bsp/db']
    try {
      await assert.rejects(resolveVaultSecret({ vaultId: id, secretId }), /HashiCorp Vault ".*": secret not found/)
      const reveal = await app.inject({ method: 'GET', url: `/vaults/${id}/secrets/${secretId}/reveal` })
      assert.equal(reveal.statusCode, 502)
    } finally {
      KV['bsp/db'] = original
    }
  })
})

describe('AppRole', () => {
  it('shares one login between parallel reads and logs in again after expiry', async () => {
    const id = await setup(approleConnection())
    const { id: secretId } = (await addSecret(id, { name: 'db', type: 'userpass', path: 'bsp/db' })).json<{ id: number }>()
    forgetHashicorpVault(id)
    logins = 0
    await Promise.all(Array.from({ length: 5 }, () => resolveVaultSecret({ vaultId: id, secretId })))
    assert.equal(logins, 1)
    await resolveVaultSecret({ vaultId: id, secretId })
    assert.equal(logins, 1)

    forgetHashicorpVault(id)
    leaseSeconds = 1
    logins = 0
    await resolveVaultSecret({ vaultId: id, secretId })
    await new Promise((r) => setTimeout(r, 1000))
    await resolveVaultSecret({ vaultId: id, secretId })
    assert.equal(logins, 2)

    forgetHashicorpVault(id)
    leaseSeconds = 0 // a lease of 0 never expires
    logins = 0
    await resolveVaultSecret({ vaultId: id, secretId })
    await resolveVaultSecret({ vaultId: id, secretId })
    assert.equal(logins, 1)
  })

  it('does not log in again when a fresh token is denied by policy', async () => {
    const id = await setup(approleConnection())
    const { id: secretId } = (await addSecret(id, { name: 'db', type: 'userpass', path: 'bsp/db' })).json<{ id: number }>()
    forgetHashicorpVault(id)
    logins = 0
    behaviour = 'forbid-once'
    await assert.rejects(resolveVaultSecret({ vaultId: id, secretId }), /permission denied/)
    assert.equal(logins, 1)
  })

  it('retries once with a new login after a 403', async () => {
    const id = await setup(approleConnection())
    const { id: secretId } = (await addSecret(id, { name: 'db', type: 'userpass', path: 'bsp/db' })).json<{ id: number }>()
    forgetHashicorpVault(id)
    logins = 0
    behaviour = 'forbid-once'
    hashicorpLimits.freshTokenMs = 0
    assert.equal((await resolveVaultSecret({ vaultId: id, secretId }))['username'], 'svc')
    assert.equal(logins, 2)
  })

  it('reports a rejected login without echoing credentials', async () => {
    const id = await setup(approleConnection({ secretId: 'bad-secret-id' }))
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.equal(res.statusCode, 502)
    assert.match(res.json<{ error: string }>().error, /AppRole login was rejected/)
    assert.doesNotMatch(res.body, /bad-secret-id|role-id-value/)
  })
})

describe('broken state', () => {
  it('rejects a userpass reference whose path lacks username or password', async () => {
    const id = await setup(tokenConnection())
    KV['bsp/partial'] = { username: 'only-user' }
    const res = await addSecret(id, { name: 'p', type: 'userpass', path: 'bsp/partial' })
    assert.equal(res.statusCode, 400)
    assert.match(res.json<{ error: string }>().error, /"username" and "password" are required/)
    delete KV['bsp/partial']
  })

  it('lets an admin repair or delete a vault whose connection cannot be decrypted', async () => {
    const id = await setup(tokenConnection())
    await db.update(vaults).set({ connectionConfig: 'deadbeef:deadbeef:deadbeef' }).where(eq(vaults.id, id))
    const rename = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { name: 'Broken but renamed' } })
    assert.equal(rename.statusCode, 200, rename.body)
    const noCreds = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: tokenConnection({ token: '' }) } })
    assert.equal(noCreds.statusCode, 400)
    const repaired = await app.inject({ method: 'PATCH', url: `/vaults/${id}`, payload: { connection: tokenConnection() } })
    assert.equal(repaired.statusCode, 200, repaired.body)
    await db.update(vaults).set({ connectionConfig: 'deadbeef:deadbeef:deadbeef' }).where(eq(vaults.id, id))
    assert.equal((await app.inject({ method: 'DELETE', url: `/vaults/${id}` })).statusCode, 204)
  })
})

describe('hostile servers', () => {
  it('does not follow redirects or forward the token', async () => {
    const id = await setup(tokenConnection())
    behaviour = 'redirect'
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.equal(res.statusCode, 502)
    assert.match(res.json<{ error: string }>().error, /redirects are not followed/)
    assert.equal(redirectTargetHits.length, 0)
  })

  it('times out', async () => {
    const id = await setup(tokenConnection())
    behaviour = 'hang'
    hashicorpLimits.timeoutMs = 150
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.equal(res.statusCode, 502)
    assert.match(res.json<{ error: string }>().error, /timed out/)
  })

  it('caps the response size', async () => {
    const id = await setup(tokenConnection())
    behaviour = 'huge'
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/test` })
    assert.equal(res.statusCode, 502)
    assert.match(res.json<{ error: string }>().error, /too large/)
  })
})
