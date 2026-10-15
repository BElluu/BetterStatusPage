import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Fastify, { type RouteOptions } from 'fastify'
import { acceptApiTokens, ADMIN_ROLE, belongsTo, createRoleRegistry, createTokenCatalogue, generateTotpCode, generateTotpSecret, totpUri, verifyTotp } from '@better-kit/auth'

describe('role registry', () => {
  const build = () => {
    const roles = createRoleRegistry()
    roles.register(['editor', 'reader'], { fallback: 'reader', defaultForNewUsers: 'reader' })
    return roles
  }

  it('always has admin and lists the registered roles after it', () => {
    assert.deepEqual(build().list(), [ADMIN_ROLE, 'editor', 'reader'])
    assert.deepEqual(createRoleRegistry().list(), [ADMIN_ROLE])
  })

  it('normalises a stored value, including the legacy JSON array, and falls back for anything else', () => {
    const roles = build()
    assert.equal(roles.normalize('editor'), 'editor')
    assert.equal(roles.normalize('["editor","reader"]'), 'editor')
    assert.equal(roles.normalize('[]'), 'reader')
    assert.equal(roles.normalize('superuser'), 'reader')
    assert.equal(roles.normalize('{broken'), 'reader')
  })

  it('knows the default role for new users and which roles are valid', () => {
    const roles = build()
    assert.equal(roles.defaultForNewUsers, 'reader')
    assert.equal(roles.isValid('editor'), true)
    assert.equal(roles.isValid('root'), false)
  })

  it('refuses a fallback that is not a role and refuses registering once frozen', () => {
    const roles = createRoleRegistry()
    assert.throws(() => roles.register(['a'], { fallback: 'b', defaultForNewUsers: 'a' }), /registered roles/)
    roles.freeze()
    assert.throws(() => roles.register(['a'], { fallback: 'a', defaultForNewUsers: 'a' }), /after the auth module was created/)
  })
})

describe('token catalogue', () => {
  const catalogue = createTokenCatalogue({
    resources: [
      { key: 'notes', label: 'Notes', description: 'Notes', levels: ['read', 'write'] },
      { key: 'stats', label: 'Stats', description: 'Stats', levels: ['read'] },
    ],
    extraScopes: ['vault:use'],
  })

  it('lists the permissions of every part, then the extra ones', () => {
    assert.deepEqual(catalogue.scopes, ['notes:read', 'notes:write', 'stats:read', 'vault:use'])
  })

  it('normalises requests against its own list and drops unknown stored permissions', () => {
    assert.deepEqual(catalogue.normalize(['notes:write']), ['notes:read', 'notes:write'])
    assert.equal(catalogue.normalize(['monitors:read']), null)
    assert.deepEqual(catalogue.parse('["notes:read","gone:read",3]'), ['notes:read'])
    assert.deepEqual(catalogue.parse('not json'), [])
  })
})

describe('route scopes', () => {
  it('tag the routes of a scope with their part and with whether a token may reach them', async () => {
    const app = Fastify({ logger: false })
    const seen = new Map<string, RouteOptions>()
    app.addHook('onRoute', (route) => { seen.set(route.url, route) })
    await app.register(async (admin) => {
      acceptApiTokens(admin)
      await admin.register(async (notes) => {
        belongsTo(notes, 'notes')
        notes.get('/notes', async () => 'ok')
      })
      await admin.register(async (accounts) => {
        acceptApiTokens(accounts, false)
        accounts.get('/accounts', async () => 'ok')
      })
    })
    await app.ready()
    // Read after ready: the scope hooks rewrite the route's config after this app-level hook has run.
    assert.deepEqual(seen.get('/notes')?.config, { allowApiToken: true, tokenScope: 'notes' })
    assert.equal(seen.get('/accounts')?.config?.allowApiToken, false)
    await app.close()
  })
})

describe('authenticator codes', () => {
  it('verify the current code and name the issuer in the enrolment link', () => {
    const secret = generateTotpSecret()
    assert.equal(verifyTotp(secret, generateTotpCode(secret)), true)
    assert.equal(verifyTotp(secret, '000000') && verifyTotp(secret, '111111'), false)
    assert.match(totpUri(secret, 'a@example.test', 'Example App'), /^otpauth:\/\/totp\/Example%20App%3Aa%40example\.test\?secret=.*&issuer=Example%20App/)
  })
})
