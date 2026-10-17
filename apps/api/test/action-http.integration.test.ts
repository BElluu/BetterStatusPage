import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { db } from '../src/db/client.js'
import { encrypt } from '../src/kit/secretBox.js'
import { actionRuns, actions, monitorActions, monitors, vaults, vaultSecrets } from '../src/db/schema.js'
import { actionRoutes } from '../src/routes/actions.js'
import { executeAction, redact } from '../src/workers/actionHttp.js'
import { processDueActionRuns, scheduleActionRuns } from '../src/workers/actionRunner.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-action-http-')
const received: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: string }> = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    received.push({ url: request.url ?? '', headers: request.headers, body })
    if (request.url === '/redirect') return void response.writeHead(302, { location: '/ok' }).end()
    if (request.url === '/boom') return void response.writeHead(500).end('Job\nqueue   is full')
    // A long answer that repeats the credential near the end, where the snippet is cut.
    if (request.url === '/pad') return void response.writeHead(500).end('x'.repeat(480) + String(request.headers['authorization']))
    if (request.url === '/long') return void response.writeHead(200).end('x'.repeat(10_000))
    // Echoes the request back, as a badly behaved target would.
    if (request.url === '/echo') return void response.writeHead(500).end(JSON.stringify({ headers: request.headers, body }))
    response.writeHead(201).end('queued')
  })
})
let baseUrl = ''
const app = Fastify({ logger: false })
const config = (patch: Record<string, unknown> = {}) => ({ url: `${baseUrl}/ok`, method: 'POST', ...patch }) as never

before(async () => {
  initTestDb()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
  app.addHook('preHandler', async (request) => { request.user = { userId: 1, email: 'admin@example.test', role: 'admin' } })
  await app.register(actionRoutes, { prefix: '/actions' })
  await app.ready()
})

beforeEach(async () => {
  received.length = 0
  await db.delete(actionRuns)
  await db.delete(monitorActions)
  await db.delete(actions)
  await db.delete(monitors)
  await db.delete(vaultSecrets)
  await db.delete(vaults)
})

after(async () => {
  await app.close()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  teardownTestDb(testDb)
})

async function secret(type: 'value' | 'userpass', payload: Record<string, string>) {
  const now = Date.now()
  const [vault] = await db.insert(vaults).values({ name: 'Jenkins', description: '', createdAt: now, updatedAt: now }).returning()
  const [row] = await db.insert(vaultSecrets).values({
    vaultId: vault!.id, name: 'token', type, encryptedValue: encrypt(JSON.stringify(payload)), createdAt: now, updatedAt: now,
  }).returning()
  return { vaultId: vault!.id, secretId: row!.id }
}

describe('executeAction', () => {
  it('reports the status and the start of the answer on one line', async () => {
    const ok = await executeAction(config(), {})
    assert.deepEqual({ ok: ok.ok, status: ok.status, snippet: ok.snippet }, { ok: true, status: 201, snippet: 'queued' })

    const failed = await executeAction(config({ url: `${baseUrl}/boom` }), {})
    assert.equal(failed.ok, false)
    assert.equal(failed.error, 'HTTP 500: Job queue is full')
    assert.equal(failed.snippet, 'Job queue is full')

    assert.equal((await executeAction(config({ url: `${baseUrl}/long` }), {})).snippet.length, 500)
  })

  it('does not follow a redirect, so nothing is sent to another address', async () => {
    const result = await executeAction(config({ url: `${baseUrl}/redirect`, headers: { 'X-Api-Key': 'abc' } }), {})

    assert.equal(result.ok, false)
    assert.equal(result.status, 302)
    assert.equal(result.error, 'HTTP 302 (redirect not followed)')
    assert.deepEqual(received.map((r) => r.url), ['/redirect'])
  })

  it('names a network failure without echoing the URL, which can hold a secret', async () => {
    const result = await executeAction(config({ url: 'http://127.0.0.1:1/build?token=hunter2hunter2' }), {})

    assert.equal(result.ok, false)
    assert.match(result.error!, /^Request failed: /)
    assert.equal(result.error!.includes('hunter2'), false)
  })

  it('puts a vault secret into a header, and removes it from what the target echoes back', async () => {
    const ref = await secret('value', { value: 'jenkins-api-token' })

    const result = await executeAction(config({ url: `${baseUrl}/echo`, headers: { Authorization: 'Bearer {{secret_jenkins}}' }, body: '{"t":"{{secret_jenkins}}"}', secrets: [{ name: 'jenkins', vault: ref }] }), {})

    assert.equal(received[0]!.headers['authorization'], 'Bearer jenkins-api-token')
    assert.equal(received[0]!.body, '{"t":"jenkins-api-token"}')
    assert.equal(result.ok, false)
    assert.equal(result.snippet.includes('jenkins-api-token'), false)
    assert.equal(result.error!.includes('jenkins-api-token'), false)
    assert.match(result.snippet, /\[secret\]/)
  })

  it('offers a user and password as {{secret_jenkins_basic}} for Basic authentication', async () => {
    const ref = await secret('userpass', { username: 'ci', password: 's3cretpass' })

    await executeAction(config({ headers: { Authorization: 'Basic {{secret_jenkins_basic}}' }, secrets: [{ name: 'jenkins', vault: ref }] }), {})

    assert.equal(received[0]!.headers['authorization'], `Basic ${Buffer.from('ci:s3cretpass').toString('base64')}`)
  })

  it('fails without sending when the secret cannot be read or a placeholder is not provided', async () => {
    const missing = await executeAction(config({ headers: { Authorization: 'Bearer {{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: { vaultId: 1, secretId: 999 } }] }), {})
    assert.equal(missing.ok, false)
    assert.match(missing.error!, /^Vault secret could not be read: /)

    const ref = await secret('value', { value: 'jenkins-api-token' })
    const unprovided = await executeAction(config({ headers: { Authorization: 'Bearer {{secret_jenkins_basic}}' }, secrets: [{ name: 'jenkins', vault: ref }] }), {})
    assert.equal(unprovided.error, '{{secret_jenkins_basic}} is not provided by the vault secret')
    assert.equal(received.length, 0)
  })

  it('does not expand a placeholder that arrives inside a variable', async () => {
    const ref = await secret('value', { value: 'jenkins-api-token' })

    await executeAction(config({ body: '{"m":"{{monitor_name}}"}', headers: { 'X-Key': '{{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: ref }] }), { monitor_name: '{{secret_jenkins}}' })

    assert.equal(received[0]!.body, '{"m":"{{secret_jenkins}}"}')
  })
})

describe('what a variable can do to a request that carries a secret', () => {
  it('encodes variables in the URL, so a renamed monitor cannot add a path segment or a query', async () => {
    const ref = await secret('value', { value: 'jenkins-api-token' })

    await executeAction(config({ url: `${baseUrl}/job/{{monitor_name}}/build`, headers: { Authorization: 'Bearer {{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: ref }] }), { monitor_name: '../../scriptText?x=' })

    assert.equal(received[0]!.url, '/job/..%2F..%2FscriptText%3Fx%3D/build')
  })

  it('refuses a placeholder in the host of a URL that is sent with a secret', async () => {
    const ref = await secret('value', { value: 'jenkins-api-token' })

    const result = await executeAction(config({ url: 'http://{{monitor_name}}.corp.test/build', headers: { Authorization: 'Bearer {{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: ref }] }), { monitor_name: 'evil' })

    assert.equal(result.ok, false)
    assert.match(result.error!, /host of the URL/)
    assert.equal(received.length, 0)

    const created = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'A', config: { url: 'https://{{monitor_name}}.corp.test/', method: 'POST', headers: { A: '{{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: ref }] } } })
    assert.equal(created.statusCode, 400)
  })
})

describe('redaction before the answer is shortened', () => {
  it('removes a secret that starts before the cut and ends after it', async () => {
    const ref = await secret('value', { value: 'jenkins-api-token-0123456789' })

    const result = await executeAction(config({ url: `${baseUrl}/pad`, headers: { Authorization: '{{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: ref }] }), {})

    assert.equal(result.snippet.includes('jenkins-api'), false)
    assert.equal(result.error!.includes('jenkins-api'), false)
  })

  it('removes a secret that contains line breaks or repeated spaces', async () => {
    const ref = await secret('value', { value: 'line one\nline  two' })

    const result = await executeAction(config({ url: `${baseUrl}/echo`, body: '{"t":"{{secret_jenkins}}"}', secrets: [{ name: 'jenkins', vault: ref }] }), {})

    assert.equal(result.snippet.includes('line one'), false)
    assert.equal(result.snippet.includes('line  two'), false)
    assert.match(result.snippet, /\[secret\]/)
  })
})

describe('placeholders of a JSON secret', () => {
  it('offers every key as {{secret_<key>}}, whatever the keys are called', async () => {
    const ref = await secret('json' as never, { value: JSON.stringify({ token: 'abcd1234efgh', value: 'plain-value' }) })

    await executeAction(config({ headers: { 'X-Token': '{{secret_jenkins_token}}', 'X-Value': '{{secret_jenkins_value}}' }, secrets: [{ name: 'jenkins', vault: ref }] }), {})

    assert.equal(received[0]!.headers['x-token'], 'abcd1234efgh')
    assert.equal(received[0]!.headers['x-value'], 'plain-value')
  })
})

describe('redact', () => {
  it('removes a secret in the forms it takes inside a request, and leaves short values alone', () => {
    const secrets = { secret: 'a b&c"d', other: 'xy' }
    assert.equal(redact('raw a b&c"d, url a%20b%26c%22d, json a b&c\\"d, xy', secrets), 'raw [secret], url [secret], json [secret], xy')
  })
})

describe('actions with a vault secret', () => {
  it('keeps the secret out of the stored variables and the run history', async () => {
    const ref = await secret('value', { value: 'jenkins-api-token' })
    const now = Date.now()
    const [monitor] = await db.insert(monitors).values({
      name: 'VM1', type: 'sqlserver', intervalSecs: 60, timeoutMs: 1_000, retries: 1,
      config: '{}', currentStatus: 'down', alertConfirmedStatus: 'down', tags: '[]', createdAt: now, updatedAt: now,
    }).returning()
    const [action] = await db.insert(actions).values({
      name: 'Start VM2', createdAt: now, updatedAt: now,
      config: JSON.stringify({ url: `${baseUrl}/echo`, method: 'POST', headers: { Authorization: 'Bearer {{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: ref }] }),
    }).returning()
    await db.insert(monitorActions).values({ monitorId: monitor!.id, actionId: action!.id, onStatus: 'down', delayMinutes: 0, cooldownMinutes: 0 })

    await scheduleActionRuns(monitor!, 'down', 'up', null)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await processDueActionRuns(Date.now() + 60_000)

    const [run] = await db.select().from(actionRuns)
    assert.equal(received[0]!.headers['authorization'], 'Bearer jenkins-api-token')
    assert.equal(JSON.stringify(run).includes('jenkins-api-token'), false)
    assert.match(run!.lastError ?? '', /^HTTP 500: /)
  })

  it('checks the placeholders against the chosen secret when the action is saved', async () => {
    const ref = await secret('value', { value: 'jenkins-api-token' })
    const create = (cfg: Record<string, unknown>) => app.inject({ method: 'POST', url: '/actions', payload: { name: 'Start VM2', config: { url: 'https://jenkins.test/build', method: 'POST', ...cfg } } })

    assert.equal((await create({ headers: { Authorization: 'Bearer {{secret_jenkins}}' } })).statusCode, 400)
    assert.equal((await create({ secrets: [{ name: 'jenkins', vault: ref }] })).statusCode, 400)
    assert.equal((await create({ headers: { Authorization: 'Basic {{secret_jenkins_basic}}' }, secrets: [{ name: 'jenkins', vault: ref }] })).statusCode, 400)
    assert.equal((await create({ headers: { Authorization: 'Bearer {{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: { vaultId: ref.vaultId, secretId: 999 } }] })).statusCode, 400)
    assert.equal((await create({ headers: { Authorization: 'Bearer {{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: { ...ref, fieldMapping: { a: 'b' } } }] })).statusCode, 400)

    const created = await create({ headers: { Authorization: 'Bearer {{secret_jenkins}}' }, secrets: [{ name: 'jenkins', vault: ref }] })
    assert.equal(created.statusCode, 200)
    assert.deepEqual(created.json().config.secrets, [{ name: 'jenkins', vault: ref }])
    assert.equal(JSON.stringify(created.json()).includes('jenkins-api-token'), false)
  })

  it('reads several secrets, each under its own name', async () => {
    const token = await secret('value', { value: 'jenkins-api-token' })
    const login = await secret('userpass', { username: 'ci', password: 's3cretpass' })

    const result = await executeAction(config({
      url: `${baseUrl}/echo`,
      headers: { Authorization: 'Basic {{secret_login_basic}}', 'X-Api-Token': '{{secret_token}}' },
      secrets: [{ name: 'token', vault: token }, { name: 'login', vault: login }],
    }), {})

    assert.equal(received[0]!.headers['x-api-token'], 'jenkins-api-token')
    assert.equal(received[0]!.headers['authorization'], `Basic ${Buffer.from('ci:s3cretpass').toString('base64')}`)
    // Both are removed from what the target echoes back.
    assert.equal(result.snippet.includes('jenkins-api-token'), false)
    assert.equal(result.snippet.includes('s3cretpass'), false)
  })

  it('refuses secrets that are unnamed, named twice, unused or used under a name the action does not have', async () => {
    const one = await secret('value', { value: 'jenkins-api-token' })
    const two = await secret('value', { value: 'other-token-value' })
    const create = (cfg: Record<string, unknown>) => app.inject({ method: 'POST', url: '/actions', payload: { name: 'A', config: { url: 'https://jenkins.test/build', method: 'POST', ...cfg } } })
    const header = { Authorization: 'Bearer {{secret_a}}' }

    assert.equal((await create({ headers: header, secrets: [{ name: 'a', vault: one }] })).statusCode, 200)
    assert.equal((await create({ headers: header, secrets: [{ name: 'a', vault: one }, { name: 'a', vault: two }] })).statusCode, 400)
    assert.equal((await create({ headers: header, secrets: [{ name: 'a', vault: one }, { name: 'b', vault: two }] })).statusCode, 400)
    assert.equal((await create({ headers: { Authorization: 'Bearer {{secret_c}}' }, secrets: [{ name: 'a', vault: one }] })).statusCode, 400)
    assert.equal((await create({ headers: header, secrets: [{ name: 'a_b', vault: one }] })).statusCode, 400)
    assert.equal((await create({ headers: header, secrets: [{ vault: one }] })).statusCode, 400)
    assert.equal((await create({ headers: header, secrets: 'a' })).statusCode, 400)
  })

  it('returns the status and answer from the test route', async () => {
    const created = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'Start VM2', config: { url: `${baseUrl}/ok`, method: 'POST' } } })
    const ok = await app.inject({ method: 'POST', url: `/actions/${created.json().id}/test` })
    assert.deepEqual(ok.json(), { ok: true, status: 201, snippet: 'queued' })

    const bad = await app.inject({ method: 'POST', url: '/actions', payload: { name: 'Boom', config: { url: `${baseUrl}/boom`, method: 'POST' } } })
    const failed = await app.inject({ method: 'POST', url: `/actions/${bad.json().id}/test` })
    assert.equal(failed.statusCode, 422)
    assert.deepEqual(failed.json(), { error: 'HTTP 500: Job queue is full', status: 500, snippet: 'Job queue is full' })
  })
})
