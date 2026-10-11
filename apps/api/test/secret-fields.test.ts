import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { maskSecrets, restoreSecrets, SECRET_MASK } from '../src/services/secretFields.js'

const httpsConfig = () => ({
  url: 'https://example.test',
  headers: { Accept: 'application/json', Authorization: 'Bearer abc', 'X-Api-Key': 'k-123' },
  auth: {
    type: 'basic',
    basic: { username: 'svc', password: 'p4ss' },
    oauth2: { tokenUrl: 'https://idp.test/token', clientId: 'id', clientSecret: 's3cret' },
    cas: { casServerUrl: 'https://cas.test', username: 'u', password: 'casp' },
  },
})

describe('maskSecrets', () => {
  it('masks credentials and leaves everything else readable', () => {
    const masked = maskSecrets('monitor', httpsConfig())
    assert.equal(masked.auth.basic.password, SECRET_MASK)
    assert.equal(masked.auth.oauth2.clientSecret, SECRET_MASK)
    assert.equal(masked.auth.cas.password, SECRET_MASK)
    assert.equal(masked.auth.basic.username, 'svc')
    assert.equal(masked.url, 'https://example.test')
    assert.deepEqual(masked.headers, { Accept: 'application/json', Authorization: SECRET_MASK, 'X-Api-Key': SECRET_MASK })
  })

  it('does not touch its input', () => {
    const config = httpsConfig()
    maskSecrets('monitor', config)
    assert.equal(config.auth.basic.password, 'p4ss')
  })

  it('masks the database password', () => {
    assert.deepEqual(maskSecrets('monitor', { host: 'db', user: 'u', password: 'pw' }), { host: 'db', user: 'u', password: SECRET_MASK })
  })

  it('masks a secret whatever the object type, so leftovers of another type never read back in the clear', () => {
    // e.g. a monitor that was an https one: the password is still in the stored config.
    assert.deepEqual(maskSecrets('monitor', { host: 'h', mode: 'tcp', auth: { basic: { password: 'p4ss' } }, password: 'pw' }),
      { host: 'h', mode: 'tcp', auth: { basic: { password: SECRET_MASK } }, password: SECRET_MASK })
    assert.deepEqual(maskSecrets('channel', { webhookUrl: 'https://hooks.test/a', botToken: '123456:ABCDEFghijMSGo' }),
      { webhookUrl: SECRET_MASK, botToken: `${SECRET_MASK}MSGo` })
  })

  it('leaves vault references and empty values alone', () => {
    const config = { host: 'db', password: '', vault: { vaultId: 1, secretId: 2 } }
    assert.deepEqual(maskSecrets('monitor', config), config)
  })

  it('masks a secret that is not text, such as a number from a YAML file', () => {
    assert.deepEqual(maskSecrets('monitor', { password: 123456, headers: { Authorization: 42 } }), { password: SECRET_MASK, headers: { Authorization: SECRET_MASK } })
  })

  it('masks channel webhook URLs, header credentials and the Telegram bot token', () => {
    for (const config of [{ webhookUrl: 'https://hooks.test/abc', text: 'hi' }]) {
      assert.deepEqual(maskSecrets('channel', config), { webhookUrl: SECRET_MASK, text: 'hi' })
    }
    assert.deepEqual(maskSecrets('channel', { url: 'https://x.test', headers: { 'Content-Type': 'application/json', 'X-Token': 't' } }),
      { url: 'https://x.test', headers: { 'Content-Type': 'application/json', 'X-Token': SECRET_MASK } })
    assert.equal(maskSecrets('channel', { botToken: '123456:ABCDEFghijMSGo', chatId: '1' }).botToken, `${SECRET_MASK}MSGo`)
    assert.equal(maskSecrets('channel', { botToken: '1:short', chatId: '1' }).botToken, SECRET_MASK)
    assert.deepEqual(maskSecrets('channel', { to: 'a@b.test' }), { to: 'a@b.test' })
  })

  it('recognises the usual credential header names', () => {
    const headers = Object.fromEntries(['Authorization', 'X-Authorization', 'Authentication', 'X-Auth', 'X-Auth-User', 'Proxy-Authorization', 'Cookie',
      'X-Session', 'X-Signature', 'X-Api-Key', 'X-Token', 'X-Secret', 'passwd', 'pwd'].map((name) => [name, 'v']))
    const masked = maskSecrets('monitor', { headers: { ...headers, Accept: 'a', 'Content-Type': 'c', 'User-Agent': 'u' } }).headers
    for (const name of Object.keys(headers)) assert.equal(masked[name as keyof typeof masked], SECRET_MASK, name)
    assert.deepEqual([masked['Accept' as keyof typeof masked], masked['Content-Type' as keyof typeof masked], masked['User-Agent' as keyof typeof masked]], ['a', 'c', 'u'])
  })

  it('copes with configs that are not objects', () => {
    assert.equal(maskSecrets('monitor', null), null)
    assert.deepEqual(maskSecrets('monitor', { headers: 'nope', auth: 'nope' }), { headers: 'nope', auth: 'nope' })
  })
})

describe('restoreSecrets', () => {
  it('turns a returned mask back into the stored secret', () => {
    const stored = httpsConfig()
    const edited = { ...maskSecrets('monitor', stored), url: 'https://example.test' }
    assert.deepEqual(restoreSecrets('monitor', edited, stored), { config: stored })
  })

  it('keeps a newly typed secret and a cleared one', () => {
    const stored = httpsConfig()
    const typed = maskSecrets('monitor', stored)
    typed.auth.basic.password = 'new-pass'
    typed.auth.cas.password = ''
    const result = restoreSecrets('monitor', typed, stored) as { config: ReturnType<typeof httpsConfig> }
    assert.equal(result.config.auth.basic.password, 'new-pass')
    assert.equal(result.config.auth.cas.password, '')
    assert.equal(result.config.auth.oauth2.clientSecret, 's3cret')
  })

  it('restores a long token whose mask shows its tail', () => {
    const stored = { botToken: '123456:ABCDEFghijMSGo', chatId: '1' }
    const result = restoreSecrets('channel', { botToken: `${SECRET_MASK}MSGo`, chatId: '2' }, stored)
    assert.deepEqual(result, { config: { botToken: '123456:ABCDEFghijMSGo', chatId: '2' } })
  })

  it('refuses a mask that matches nothing stored, naming the field', () => {
    const stored = { host: 'db', password: 'pw' }
    const forgedTail = restoreSecrets('monitor', { host: 'db', password: `${SECRET_MASK}x` }, stored)
    assert.match((forgedTail as { error: string }).error, /^password is a masked placeholder/)
    assert.ok('error' in restoreSecrets('monitor', { host: 'db', password: SECRET_MASK }, undefined))
    const otherField = restoreSecrets('monitor', { auth: { basic: { password: SECRET_MASK } } }, { auth: { oauth2: { clientSecret: 'x' } } })
    assert.match((otherField as { error: string }).error, /^auth\.basic\.password /)
  })

  it('refuses a mask somebody edited by hand instead of saving it as the secret', () => {
    const stored = { host: 'db', password: 'pw' }
    for (const edited of ['•••••••', 'x••••••••', '••••••••x', '•••••••• ', '•••']) {
      assert.ok('error' in restoreSecrets('monitor', { host: 'db', password: edited }, stored), JSON.stringify(edited))
    }
    // Two bullets are an ordinary character sequence.
    assert.deepEqual(restoreSecrets('monitor', { host: 'db', password: 'a••b' }, stored), { config: { host: 'db', password: 'a••b' } })
  })

  it('refuses a secret that is not text', () => {
    const result = restoreSecrets('monitor', { host: 'db', password: 123456 }, undefined)
    assert.deepEqual(result, { error: 'password must be text' })
    assert.ok('error' in restoreSecrets('monitor', { headers: { Authorization: 1 } }, undefined))
  })

  it('restores header credentials by header name', () => {
    const stored = { url: 'https://x.test', headers: { 'X-Token': 'tok', Accept: 'a' } }
    const ok = restoreSecrets('channel', { url: 'https://x.test', headers: { 'X-Token': SECRET_MASK, Accept: 'a' } }, stored)
    assert.deepEqual(ok, { config: stored })
    const renamed = restoreSecrets('channel', { url: 'https://x.test', headers: { 'X-Other-Token': SECRET_MASK } }, stored)
    assert.match((renamed as { error: string }).error, /^headers\.X-Other-Token /)
  })

  it('has nothing to check for a config without secrets', () => {
    const config = { to: SECRET_MASK }
    assert.deepEqual(restoreSecrets('channel', config, undefined), { config })
  })
})

describe('restoreSecrets will not redirect a kept secret', () => {
  it('refuses a new URL, host or port while a stored secret is kept', () => {
    const stored = httpsConfig()
    for (const [change, field] of [
      [(c: ReturnType<typeof httpsConfig>) => { c.url = 'https://attacker.test' }, 'url'],
      [(c: ReturnType<typeof httpsConfig>) => { c.auth.oauth2.tokenUrl = 'https://attacker.test/token' }, 'auth.oauth2.tokenUrl'],
      [(c: ReturnType<typeof httpsConfig>) => { c.auth.cas.casServerUrl = 'https://attacker.test' }, 'auth.cas.casServerUrl'],
    ] as const) {
      const edited = maskSecrets('monitor', stored)
      change(edited)
      const result = restoreSecrets('monitor', edited, stored)
      assert.match((result as { error: string }).error, new RegExp(`^${field.replace('.', '\\.')} changed`), field)
    }
    const db = { host: 'db', port: 5432, user: 'u', password: 'pw' }
    assert.ok('error' in restoreSecrets('monitor', { ...maskSecrets('monitor', db), host: 'attacker.test' }, db))
    assert.ok('error' in restoreSecrets('monitor', { ...maskSecrets('monitor', db), port: 25 }, db))
  })

  it('allows the change once the secret is entered again, and changes that do not move the secret', () => {
    const stored = httpsConfig()
    const moved = { ...maskSecrets('monitor', stored), url: 'https://new.test' }
    moved.auth.basic.password = 'again'
    moved.auth.oauth2.clientSecret = 'again'
    moved.auth.cas.password = 'again'
    moved.headers.Authorization = 'again'
    moved.headers['X-Api-Key'] = 'again'
    assert.ok('config' in restoreSecrets('monitor', moved, stored))

    const db = { host: 'db', port: 5432, user: 'u', password: 'pw' }
    assert.ok('config' in restoreSecrets('monitor', { ...maskSecrets('monitor', db), user: 'other', database: 'd2' }, db))
  })

  it('guards a webhook channel the same way', () => {
    const stored = { url: 'https://hooks.test', headers: { 'X-Token': 'tok' } }
    assert.ok('error' in restoreSecrets('channel', { url: 'https://attacker.test', headers: { 'X-Token': SECRET_MASK } }, stored))
    assert.ok('config' in restoreSecrets('channel', { url: 'https://hooks.test/other-path-is-a-different-url', headers: { 'X-Token': 'new' } }, stored))
  })
})
