import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { SMTPServer } from 'smtp-server'
import { db, sqlite } from '../src/db/client.js'
import { smtpSettings, vaults, vaultSecrets } from '../src/db/schema.js'
import { encrypt } from '../src/crypto/vault.js'
import { isSmtpConfigured, sendSmtpMail } from '../src/workers/notifier.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const testDb = createTestDb('bsp-smtp-vault-test-')
process.env['VAULT_ENCRYPTION_KEY'] = 'abcdef0123456789'.repeat(4)

const logins: Array<{ username: string; password: string }> = []
const mails: Array<{ from: string; to: string[]; raw: string }> = []
const smtpServer = new SMTPServer({
  authOptional: false,
  allowInsecureAuth: true,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, _session, callback) {
    logins.push({ username: auth.username ?? '', password: auth.password ?? '' })
    if (auth.password === 'wrong') return callback(new Error('Invalid credentials'))
    callback(null, { user: auth.username })
  },
  onData(stream, session, callback) {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => {
      mails.push({
        from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
        to: session.envelope.rcptTo.map((r) => r.address),
        raw: Buffer.concat(chunks).toString(),
      })
      callback()
    })
  },
})
let smtpPort = 0
let vaultId = 0

async function addSecret(name: string, type: string, payload: unknown): Promise<number> {
  const [row] = await db.insert(vaultSecrets).values({
    vaultId, name, type, encryptedValue: encrypt(JSON.stringify(payload)), createdAt: Date.now(), updatedAt: Date.now(),
  }).returning()
  return row!.id
}

async function configureSmtp(values: Partial<typeof smtpSettings.$inferInsert>): Promise<void> {
  await db.insert(smtpSettings).values({
    id: 1, host: '127.0.0.1', port: smtpPort, secure: 0, user: '', password: '',
    fromAddress: 'alerts@example.test', fromName: 'BSP Alerts', vaultConfig: null, updatedAt: Date.now(), ...values,
  })
}

const message = { to: 'ops@example.test', subject: 'Monitor down', text: 'API is down' }

before(async () => {
  initTestDb()
  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve))
  const address = smtpServer.server.address()
  if (!address || typeof address === 'string') throw new Error('SMTP test server did not bind')
  smtpPort = address.port
  const [vault] = await db.insert(vaults).values({ name: 'Mail', type: 'local', createdAt: Date.now(), updatedAt: Date.now() }).returning()
  vaultId = vault!.id
})

beforeEach(() => {
  sqlite.exec('DELETE FROM smtp_settings')
  logins.length = 0
  mails.length = 0
})

after(async () => {
  await new Promise<void>((resolve) => smtpServer.close(() => resolve()))
  teardownTestDb(testDb)
})

describe('SMTP delivery', () => {
  it('reports SMTP as unconfigured and refuses to send without a host', async () => {
    assert.equal(await isSmtpConfigured(), false)
    await assert.rejects(() => sendSmtpMail(message), /SMTP not configured/)

    await configureSmtp({ host: '' })
    assert.equal(await isSmtpConfigured(), false)
    await assert.rejects(() => sendSmtpMail(message), /SMTP not configured/)
  })

  it('authenticates with the stored username and password', async () => {
    await configureSmtp({ user: 'stored-user', password: 'stored-pass' })
    assert.equal(await isSmtpConfigured(), true)

    await sendSmtpMail(message)

    assert.deepEqual(logins, [{ username: 'stored-user', password: 'stored-pass' }])
    assert.equal(mails.length, 1)
    assert.equal(mails[0]!.from, 'alerts@example.test')
    assert.deepEqual(mails[0]!.to, ['ops@example.test'])
    assert.match(mails[0]!.raw, /From: BSP Alerts <alerts@example\.test>/)
    assert.match(mails[0]!.raw, /Subject: Monitor down/)
  })

  it('prefers userpass credentials from the vault over stored ones', async () => {
    const secretId = await addSecret('smtp-userpass', 'userpass', { username: 'vault-user', password: 'vault-pass' })
    await configureSmtp({ user: 'stored-user', password: 'stored-pass', vaultConfig: JSON.stringify({ vaultId, secretId }) })

    await sendSmtpMail(message)

    assert.deepEqual(logins, [{ username: 'vault-user', password: 'vault-pass' }])
    assert.equal(mails.length, 1)
  })

  it('uses a value secret as the password and keeps the stored username', async () => {
    const secretId = await addSecret('smtp-value', 'value', { value: 'vault-only-pass' })
    await configureSmtp({ user: 'stored-user', password: 'stored-pass', vaultConfig: JSON.stringify({ vaultId, secretId }) })

    await sendSmtpMail(message)

    assert.deepEqual(logins, [{ username: 'stored-user', password: 'vault-only-pass' }])
  })

  it('maps json secret fields through fieldMapping', async () => {
    const secretId = await addSecret('smtp-json', 'json', { value: JSON.stringify({ login: 'json-user', secret: 'json-pass' }) })
    await configureSmtp({
      vaultConfig: JSON.stringify({ vaultId, secretId, fieldMapping: { username: 'login', password: 'secret' } }),
    })

    await sendSmtpMail(message)

    assert.deepEqual(logins, [{ username: 'json-user', password: 'json-pass' }])
  })

  it('fails without sending when the referenced vault secret is gone', async () => {
    await configureSmtp({ user: 'stored-user', password: 'stored-pass', vaultConfig: JSON.stringify({ vaultId, secretId: 99_999 }) })

    await assert.rejects(() => sendSmtpMail(message), /Vault secret 99999 not found/)
    assert.equal(logins.length, 0)
    assert.equal(mails.length, 0)
  })

  it('surfaces an authentication rejection from the SMTP server', async () => {
    await configureSmtp({ user: 'stored-user', password: 'wrong' })

    await assert.rejects(() => sendSmtpMail(message), /Invalid credentials|auth/i)
    assert.equal(mails.length, 0)
  })
})
