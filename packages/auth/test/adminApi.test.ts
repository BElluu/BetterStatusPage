import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { registerAdminApi } from '@better-forge/auth'

const seen = (req: FastifyRequest) => {
  const { allowApiToken, tokenScope } = req.routeOptions.config as { allowApiToken?: boolean; tokenScope?: string }
  return { allowApiToken, tokenScope }
}

async function widgets(app: FastifyInstance) {
  app.get('/list', async (req) => seen(req))
}
async function secrets(app: FastifyInstance) {
  app.get('/list', async (req) => seen(req))
}

async function build(guards: string[]) {
  const app = Fastify()
  await app.register(async (admin) => {
    await registerAdminApi(admin, {
      authenticate: async () => { guards.push('authenticate') },
      groups: [
        { part: 'widgets', guard: async () => { guards.push('widgets-guard') }, routes: [[widgets, { prefix: '/widgets' }]] },
        {
          noTokens: true,
          guard: async (_req: FastifyRequest, reply: FastifyReply) => { guards.push('secrets-guard'); if (_req.headers['x-deny']) return reply.code(403).send({ error: 'no' }) },
          routes: [[secrets, { prefix: '/secrets' }]],
        },
      ],
    })
  }, { prefix: '/admin' })
  await app.ready()
  return app
}

describe('the admin API', () => {
  it('lets the routes of a group accept API tokens for the part of the API they belong to', async () => {
    const app = await build([])
    assert.deepEqual((await app.inject('/admin/widgets/list')).json(), { allowApiToken: true, tokenScope: 'widgets' })
    await app.close()
  })

  it('keeps a group out of reach of tokens when it says so, and gives its routes no part', async () => {
    const app = await build([])
    assert.deepEqual((await app.inject('/admin/secrets/list')).json(), { allowApiToken: false })
    await app.close()
  })

  it('runs the sign-in check before the guard of the group, and stops at a guard that refuses', async () => {
    const guards: string[] = []
    const app = await build(guards)
    await app.inject('/admin/widgets/list')
    assert.deepEqual(guards, ['authenticate', 'widgets-guard'])
    guards.length = 0
    const denied = await app.inject({ url: '/admin/secrets/list', headers: { 'x-deny': '1' } })
    assert.equal(denied.statusCode, 403)
    assert.deepEqual(guards, ['authenticate', 'secrets-guard'])
    await app.close()
  })
})
