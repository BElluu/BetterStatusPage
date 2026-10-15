import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VAULT_USE_SCOPE } from '@better-kit/contracts'
import { createSecretBox, createSecretFields, createVaultUseGuard, SECRET_MASK, uniqueSecretFields, validateEncryptionKey, type SecretField } from '@better-kit/vault'

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('secret box', () => {
  it('round-trips text and never produces the same ciphertext twice', () => {
    const box = createSecretBox({ env: { VAULT_ENCRYPTION_KEY: KEY } })
    const sealed = box.encrypt('s3cret ✓')
    assert.notEqual(sealed, box.encrypt('s3cret ✓'))
    assert.equal(box.decrypt(sealed), 's3cret ✓')
  })

  it('refuses tampered or malformed data and a key of the wrong shape', () => {
    const box = createSecretBox({ env: { VAULT_ENCRYPTION_KEY: KEY } })
    const [iv, tag, body] = box.encrypt('x').split(':') as [string, string, string]
    assert.throws(() => box.decrypt(`${iv}:${tag}:${body.replace(/.$/, body.endsWith('0') ? '1' : '0')}`))
    assert.throws(() => box.decrypt('nope'), /Invalid ciphertext format/)
    assert.throws(() => box.decrypt(`${iv}:00:${body}`), /Invalid ciphertext length/)
    assert.throws(() => createSecretBox({ env: { VAULT_ENCRYPTION_KEY: 'abcd' } }).encrypt('x'), /64-character hex/)
  })

  it('needs a key in production, and only there', () => {
    assert.throws(() => createSecretBox({ env: { NODE_ENV: 'production' } }).encrypt('x'), /must be set in production/)
    assert.throws(() => validateEncryptionKey({ NODE_ENV: 'production', VAULT_ENCRYPTION_KEY: 'change-me' }), /64 hexadecimal/)
    assert.doesNotThrow(() => validateEncryptionKey({ NODE_ENV: 'production', VAULT_ENCRYPTION_KEY: KEY }))
    assert.doesNotThrow(() => validateEncryptionKey({ NODE_ENV: 'development' }))
  })
})

describe('vault use guard', () => {
  const guard = createVaultUseGuard({ target: 'job' })
  const withoutVault = { scopes: ['jobs:write'] }

  it('names the permission and the application-specific target in its message', () => {
    assert.match(guard.refused, new RegExp(`"${VAULT_USE_SCOPE}" permission`))
    assert.match(guard.refused, /configuration of a job that has one/)
  })

  it('lets a token without the permission keep or remove a reference but not add or change one', () => {
    const stored = { name: 'a', auth: { vault: { vaultId: 1, secretId: 2 } } }
    assert.equal(guard.vaultUseProblem(withoutVault, { name: 'b' }, undefined), null)
    assert.equal(guard.vaultUseProblem(withoutVault, { name: 'b', auth: { vault: { secretId: 2, vaultId: 1 } } }, { ...stored, name: 'b' }), null)
    assert.equal(guard.vaultUseProblem(withoutVault, { auth: { vault: { vaultId: 1, secretId: 3 } } }, stored), guard.refused)
    assert.equal(guard.vaultUseProblem(withoutVault, stored, undefined), guard.refused)
    assert.equal(guard.vaultUseProblem({ scopes: [VAULT_USE_SCOPE] }, stored, undefined), null)
    assert.equal(guard.vaultUseProblem(undefined, stored, undefined), null)
  })
})

describe('secret fields', () => {
  const FIELDS: readonly SecretField[] = uniqueSecretFields([
    { path: ['password'] }, { path: ['password'] }, { path: ['token'], tail: true }, { mapAt: ['headers'] },
  ])
  const fields = createSecretFields({ job: { fields: FIELDS, destinations: [['url']] } })

  it('lists each secret field once', () => {
    assert.equal(FIELDS.length, 3)
  })

  it('masks every secret, headers that look like credentials, and shows the tail of long tokens only', () => {
    const masked = fields.maskSecrets('job', { url: 'https://a.test', password: 'p', token: 'abcdefghijklmnopqrstuvwxyz', headers: { Authorization: 'Bearer x', Accept: 'json' } })
    assert.deepEqual(masked, {
      url: 'https://a.test', password: SECRET_MASK, token: `${SECRET_MASK}wxyz`, headers: { Authorization: SECRET_MASK, Accept: 'json' },
    })
  })

  it('turns a returned mask back into the stored secret and refuses anything else that looks masked', () => {
    const stored = { url: 'https://a.test', password: 'p' }
    assert.deepEqual(fields.restoreSecrets('job', { url: 'https://a.test', password: SECRET_MASK }, stored), { config: stored })
    assert.ok('error' in fields.restoreSecrets('job', { password: SECRET_MASK }, undefined))
    assert.ok('error' in fields.restoreSecrets('job', { url: 'https://a.test', password: '•••• edited' }, stored))
    assert.ok('error' in fields.restoreSecrets('job', { url: 'https://a.test', password: 5 }, stored))
  })

  it('does not keep a stored secret when the place it is sent to changed', () => {
    const result = fields.restoreSecrets('job', { url: 'https://elsewhere.test', password: SECRET_MASK }, { url: 'https://a.test', password: 'p' })
    assert.ok('error' in result && /url changed/.test(result.error))
    assert.equal(fields.changedDestination('job', { url: '' }, {}), null)
  })
})
