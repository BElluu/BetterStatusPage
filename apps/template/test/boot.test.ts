import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

// Proof that the shared modules make an application on their own: this boots the template, a server that imports
// nothing but @better-kit packages, on an empty data directory and uses it the way a person would.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let child: ChildProcess
let base = ''
let dataDir = ''
const cookies = new Map<string, string>()
let output = ''

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function call(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (cookies.size) headers['cookie'] = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  if (body !== undefined) headers['content-type'] = 'application/json'
  const csrf = cookies.get('tpl_csrf')
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf
  const response = await fetch(`${base}${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';')
    const [name, ...value] = pair!.split('=')
    if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(header)) cookies.delete(name!)
    else cookies.set(name!, value.join('='))
  }
  const text = await response.text()
  return { status: response.status, json: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) as Record<string, any> : text } // eslint-disable-line @typescript-eslint/no-explicit-any
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-template-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src/server/index.ts')], {
    cwd: root,
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'development', JWT_SECRET: 'test-secret-'.repeat(4),
      VAULT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(4),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/health`)).ok) return } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`The template did not start:\n${output}`)
})

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exited
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('the template, built from the shared modules only', () => {
  it('asks for setup on an empty data directory, and is not ready until it is done', async () => {
    assert.deepEqual((await call('GET', '/api/v1/setup/status')).json, { needsSetup: true })
    assert.equal((await call('GET', '/ready')).status, 503)
  })

  it('creates the administrator and signs them in', async () => {
    const response = await call('POST', '/api/v1/setup/complete', { email: 'admin@example.test', password: 'a-long-password' })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json['role'], 'admin')
    assert.deepEqual((await call('GET', '/api/v1/setup/status')).json, { needsSetup: false })
    assert.equal((await call('GET', '/ready')).status, 200)
    assert.equal((await call('POST', '/api/v1/setup/complete', { email: 'other@example.test', password: 'another-password' })).status, 409)
    const session = await call('GET', '/api/v1/auth/session')
    assert.equal(session.json['email'], 'admin@example.test')
  })

  it('keeps people who are not signed in out of the admin API', async () => {
    const saved = new Map(cookies)
    cookies.clear()
    assert.equal((await call('GET', '/api/v1/admin/users')).status, 401)
    for (const [name, value] of saved) cookies.set(name, value)
  })

  it('manages users: creates a member and lists both', async () => {
    const created = await call('POST', '/api/v1/admin/users', { email: 'member@example.test', role: 'member' })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    assert.ok(created.json['temporaryPassword'])
    const users = (await call('GET', '/api/v1/admin/users')).json as unknown as Array<{ email: string; role: string }>
    assert.deepEqual(users.map((user) => [user.email, user.role]).sort(), [['admin@example.test', 'admin'], ['member@example.test', 'member']])
  })

  it('creates an API token for the parts of the API the template has, and refuses one for a part it does not', async () => {
    const created = await call('POST', '/api/v1/admin/api-tokens', { name: 'CI', scopes: ['audit:read'], expiresInDays: 30 })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    assert.match(created.json['token'], /^tpl_/)
    assert.equal((await call('POST', '/api/v1/admin/api-tokens', { name: 'Bad', scopes: ['monitors:read'], expiresInDays: 30 })).status, 400)
    // The token reads the audit log and nothing else.
    const bearer = { authorization: `Bearer ${created.json['token']}` }
    assert.equal((await fetch(`${base}/api/v1/admin/audit`, { headers: bearer })).status, 200)
    assert.equal((await fetch(`${base}/api/v1/admin/users`, { headers: bearer })).status, 403)
  })

  it('records what happened in the audit log', async () => {
    const log = (await call('GET', '/api/v1/admin/audit')).json as unknown as { entries: Array<{ entityType: string; action: string }> }
    assert.ok(log.entries.some((entry) => entry.entityType === 'user' && entry.action === 'create'))
    assert.ok(log.entries.some((entry) => entry.entityType === 'api_token'))
  })

  it('keeps secrets in a vault and lists them by name', async () => {
    const vault = await call('POST', '/api/v1/admin/vaults', { name: 'Main', type: 'local' })
    assert.equal(vault.status, 200, JSON.stringify(vault.json))
    const secret = await call('POST', `/api/v1/admin/vaults/${vault.json['id']}/secrets`, { name: 'db', type: 'value', value: 'hunter2' })
    assert.equal(secret.status, 200, JSON.stringify(secret.json))
    const catalogue = await call('GET', '/api/v1/admin/vaults')
    assert.deepEqual((catalogue.json as unknown as Array<{ name: string }>).map((entry) => entry.name), ['Main'])
    const secrets = await call('GET', `/api/v1/admin/vaults/${vault.json['id']}/secrets`)
    assert.ok(JSON.stringify(secrets.json).includes('"db"'))
    assert.ok(!JSON.stringify([catalogue.json, secrets.json]).includes('hunter2'), 'a secret value is never listed')
  })

  it('creates a notification channel and sends a test through a webhook', async () => {
    const received: string[] = []
    const hook = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const server = net.createServer((socket) => {
        let data = ''
        socket.on('data', (chunk) => { data += chunk.toString(); if (data.includes('\r\n\r\n')) { received.push(data); socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n') } })
      })
      server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/hook`, close: () => server.close() }))
    })
    try {
      const channel = await call('POST', '/api/v1/admin/notifications/channels', {
        name: 'Hook', type: 'webhook', config: { url: hook.url, method: 'POST', body: '{"title":"{{title}}"}' },
      })
      assert.equal(channel.status, 200, JSON.stringify(channel.json))
      const test = await call('POST', `/api/v1/admin/notifications/channels/${channel.json['id']}/test`)
      assert.equal(test.status, 200, JSON.stringify(test.json))
      assert.ok(received.some((request) => request.includes('Test notification')))
      const deliveries = (await call('GET', '/api/v1/admin/notifications/deliveries')).json as unknown as { deliveries: Array<{ status: string }> }
      assert.equal(deliveries.deliveries[0]!.status, 'delivered')
    } finally { hook.close() }
  })

  it('makes a backup that can be listed, verified and downloaded', async () => {
    const created = await call('POST', '/api/v1/admin/backups')
    assert.equal(created.status, 200, JSON.stringify(created.json))
    const listed = (await call('GET', '/api/v1/admin/backups')).json as unknown as { backups: Array<{ filename: string }> }
    assert.equal(listed.backups[0]!.filename, created.json['filename'])
    const download = await fetch(`${base}/api/v1/admin/backups/${created.json['filename']}/download`, { headers: { cookie: [...cookies].map(([n, v]) => `${n}=${v}`).join('; ') } })
    assert.equal(download.status, 200)
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 8).toString(), 'KITTPL01')
  })

  it('signs out', async () => {
    assert.equal((await call('POST', '/api/v1/auth/logout')).status, 204)
    cookies.delete('tpl_session')
    assert.equal((await call('GET', '/api/v1/auth/session')).status, 401)
  })
})
