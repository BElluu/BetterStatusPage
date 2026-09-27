import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { after, before, describe, it } from 'node:test'
import { db } from '../src/db/client.js'
import { vaults, vaultSecrets } from '../src/db/schema.js'
import { encrypt } from '../src/crypto/vault.js'
import { checkDns } from '../src/workers/dns.js'
import { checkSqlServer } from '../src/workers/sqlserver.js'
import { resolveVaultSecret } from '../src/workers/resolveSecret.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-worker-errors-test-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

// ── Minimal authoritative DNS server ─────────────────────────────────────────

const TYPE = { A: 1, CNAME: 5, MX: 15, TXT: 16 } as const

function encodeName(name: string): Buffer {
  return Buffer.concat([...name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])])
}

function txtData(parts: string[]): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])))
}

const zone: Record<string, Partial<Record<number, Buffer[]>>> = {
  'up.test': {
    [TYPE.A]: [Buffer.from([10, 0, 0, 1])],
    [TYPE.TXT]: [txtData(['v=spf1 ', 'include:mail.test'])],
    [TYPE.MX]: [Buffer.concat([Buffer.from([0, 10]), encodeName('mail.up.test')])],
  },
  'www.up.test': { [TYPE.CNAME]: [encodeName('up.test')] },
}

const dnsServer = createSocket('udp4')
dnsServer.on('message', (query, remote) => {
  let offset = 12
  const labels: string[] = []
  while (query[offset]! > 0) {
    labels.push(query.subarray(offset + 1, offset + 1 + query[offset]!).toString())
    offset += query[offset]! + 1
  }
  const questionEnd = offset + 5
  const name = labels.join('.').toLowerCase()
  const qtype = query.readUInt16BE(offset + 1)
  if (name === 'silent.test') return

  const known = zone[name]
  const answers = known?.[qtype] ?? []
  const header = Buffer.alloc(12)
  query.copy(header, 0, 0, 2)
  header.writeUInt16BE(known ? 0x8180 : 0x8183, 2) // NOERROR or NXDOMAIN
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(answers.length, 6)
  const records = answers.map((data) => {
    const record = Buffer.alloc(12)
    record.writeUInt16BE(0xc00c, 0) // pointer to the question name
    record.writeUInt16BE(qtype, 2)
    record.writeUInt16BE(1, 4)
    record.writeUInt32BE(60, 6)
    record.writeUInt16BE(data.length, 10)
    return Buffer.concat([record, data])
  })
  dnsServer.send(Buffer.concat([header, query.subarray(12, questionEnd), ...records]), remote.port, remote.address)
})
let resolver = ''

// ── Vault fixtures ───────────────────────────────────────────────────────────

let vaultId = 0
let otherVaultId = 0

async function addSecret(name: string, type: string, payload: unknown, inVault = vaultId): Promise<number> {
  const [row] = await db.insert(vaultSecrets).values({
    vaultId: inVault, name, type, encryptedValue: encrypt(JSON.stringify(payload)), createdAt: Date.now(), updatedAt: Date.now(),
  }).returning()
  return row!.id
}

before(async () => {
  await new Promise<void>((resolve) => dnsServer.bind(0, '127.0.0.1', resolve))
  resolver = `127.0.0.1:${dnsServer.address().port}`
  initTestDb()
  const [first, second] = await db.insert(vaults).values([
    { name: 'Primary', type: 'local', createdAt: Date.now(), updatedAt: Date.now() },
    { name: 'Other', type: 'local', createdAt: Date.now(), updatedAt: Date.now() },
  ]).returning()
  vaultId = first!.id
  otherVaultId = second!.id
})

after(() => {
  dnsServer.close()
  teardownTestDb(testDb)
})

describe('DNS monitor', () => {
  it('is up when the record resolves and contains the expected value', async () => {
    const result = await checkDns({ hostname: 'up.test', recordType: 'A', resolver, expectedValue: '10.0.0.1' }, 2_000)
    assert.deepEqual({ status: result.status, error: result.error }, { status: 'up', error: null })
    assert.equal(typeof result.responseMs, 'number')
  })

  it('flattens MX, TXT and CNAME answers before matching', async () => {
    const mx = await checkDns({ hostname: 'up.test', recordType: 'MX', resolver, expectedValue: 'mail.up.test' }, 2_000)
    assert.equal(mx.status, 'up', mx.error ?? '')
    const txt = await checkDns({ hostname: 'up.test', recordType: 'TXT', resolver, expectedValue: 'v=spf1 include:mail.test' }, 2_000)
    assert.equal(txt.status, 'up', txt.error ?? '')
    const cname = await checkDns({ hostname: 'www.up.test', recordType: 'CNAME', resolver, expectedValue: 'up.test' }, 2_000)
    assert.equal(cname.status, 'up', cname.error ?? '')
  })

  it('is degraded when the answer lacks the expected value', async () => {
    const result = await checkDns({ hostname: 'up.test', recordType: 'A', resolver, expectedValue: '10.0.0.99' }, 2_000)
    assert.equal(result.status, 'degraded')
    assert.equal(result.error, 'Expected "10.0.0.99" not found in: 10.0.0.1')
  })

  it('is down for a name that does not exist', async () => {
    const result = await checkDns({ hostname: 'missing.test', recordType: 'A', resolver }, 2_000)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /ENOTFOUND/)
  })

  it('is down when an existing name has no record of the requested type', async () => {
    const result = await checkDns({ hostname: 'www.up.test', recordType: 'A', resolver }, 2_000)
    assert.equal(result.status, 'down')
    assert.ok(result.error)
  })

  it('times out when the resolver never answers', async () => {
    const result = await checkDns({ hostname: 'silent.test', recordType: 'A', resolver }, 150)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'DNS query timed out')
  })

  it('reports an invalid resolver address as down instead of throwing', async () => {
    const result = await checkDns({ hostname: 'up.test', recordType: 'A', resolver: 'not an ip' }, 500)
    assert.equal(result.status, 'down')
    assert.ok(result.error)
  })
})

describe('vault secret resolution', () => {
  it('returns userpass, value and json secrets as flat string maps', async () => {
    const userpass = await addSecret('userpass', 'userpass', { username: 'u', password: 'p' })
    const value = await addSecret('value', 'value', { value: 'v' })
    const json = await addSecret('json', 'json', { value: JSON.stringify({ a: 1, b: null, c: 'x' }) })
    assert.deepEqual(await resolveVaultSecret({ vaultId, secretId: userpass }), { username: 'u', password: 'p' })
    assert.deepEqual(await resolveVaultSecret({ vaultId, secretId: value }), { value: 'v' })
    assert.deepEqual(await resolveVaultSecret({ vaultId, secretId: json }), { a: '1', b: '', c: 'x' })
  })

  it('renames json keys through fieldMapping and drops empty mappings', async () => {
    const json = await addSecret('mapped', 'json', { value: JSON.stringify({ client_id: 'id-1', client_secret: 's-1' }) })
    const resolved = await resolveVaultSecret({
      vaultId, secretId: json, fieldMapping: { clientId: 'client_id', clientSecret: '', missing: 'nope' },
    })
    assert.deepEqual(resolved, { clientId: 'id-1', missing: '' })
  })

  it('refuses a secret that belongs to a different vault', async () => {
    const secretId = await addSecret('foreign', 'value', { value: 'other' }, otherVaultId)
    await assert.rejects(() => resolveVaultSecret({ vaultId, secretId }), new RegExp(`Vault secret ${secretId} not found in vault ${vaultId}`))
  })

  it('rejects unknown secret types and undecryptable values', async () => {
    const unknown = await addSecret('legacy', 'certificate', { value: 'x' })
    await assert.rejects(() => resolveVaultSecret({ vaultId, secretId: unknown }), /Unknown vault secret type: certificate/)

    const [tampered] = await db.insert(vaultSecrets).values({
      vaultId, name: 'tampered', type: 'value', encryptedValue: 'not-a-ciphertext', createdAt: 1, updatedAt: 1,
    }).returning()
    await assert.rejects(() => resolveVaultSecret({ vaultId, secretId: tampered!.id }))
  })
})

describe('SQL Server monitor', () => {
  const base = { host: '127.0.0.1', port: 1, database: 'db', user: 'sa', password: 'pw', query: 'SELECT 1' }

  it('requires a vault secret in connection string mode', async () => {
    const result = await checkSqlServer({ ...base, mode: 'connectionString' }, 200)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'SQL Server connection string mode requires a vault secret')
  })

  it('reports an empty connection string from the vault', async () => {
    const secretId = await addSecret('empty-conn', 'value', { value: '' })
    const result = await checkSqlServer({ ...base, mode: 'connectionString', vault: { vaultId, secretId } }, 200)
    assert.equal(result.status, 'down')
    assert.equal(result.error, 'SQL Server: resolved connection string is empty')
  })

  it('reports a missing vault secret as down', async () => {
    const result = await checkSqlServer({ ...base, vault: { vaultId, secretId: 424_242 } }, 200)
    assert.equal(result.status, 'down')
    assert.match(result.error ?? '', /Vault secret 424242 not found/)
  })

  it('connects every monitor to its own server, even when checks overlap', async () => {
    // mssql's global pool would hand the second check the first check's connection attempt.
    const [first, second] = await Promise.all([
      checkSqlServer({ ...base, port: 1 }, 1_000),
      checkSqlServer({ ...base, port: 2 }, 1_000),
    ])
    assert.equal(first.status, 'down')
    assert.equal(second.status, 'down')
    assert.match(first.error ?? '', /127\.0\.0\.1:1\b/)
    assert.match(second.error ?? '', /127\.0\.0\.1:2\b/)
  })

  it('reaches the connection step with vault credentials and fails on a refused port', async () => {
    const secretId = await addSecret('sql-creds', 'userpass', { username: 'vault-sa', password: 'vault-pw' })
    const result = await checkSqlServer({ ...base, vault: { vaultId, secretId } }, 500)
    assert.equal(result.status, 'down')
    assert.ok(result.error)
    assert.doesNotMatch(result.error, /Vault secret/)
  })
})
