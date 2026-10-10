import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import Fastify, { type RouteOptions } from 'fastify'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import { parse } from 'yaml'
import { adminApi } from '../src/adminApi.js'
import { db } from '../src/db/client.js'
import { apiTokens, users } from '../src/db/schema.js'
import { generateApiToken } from '../src/services/apiTokens.js'
import { createTestDb, initTestDb, teardownTestDb } from './helpers/testDb.js'

const SPEC_PATH = fileURLToPath(new URL('../../../docs/public/openapi.yaml', import.meta.url))
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const ROLES = ['operator', 'branding', 'admin']

interface Operation { summary?: string; 'x-role'?: string; parameters?: unknown[]; responses?: Record<string, unknown> }
interface Spec {
  paths: Record<string, Record<string, Operation> & { parameters?: Array<{ name?: string; $ref?: string }> }>
  components: { parameters: Record<string, { name: string }> }
}

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Spec
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  HTTP_METHODS.filter((method) => item[method]).map((method) => ({ path, method, operation: item[method] as Operation, item })))

const testDb = createTestDb('bsp-openapi-')
const app = Fastify({ logger: false })
const routes: RouteOptions[] = []
const tokens: Record<string, string> = {}

before(async () => {
  initTestDb()
  app.addHook('onRoute', (route) => { routes.push(route) })
  await app.register(cookie)
  await app.register(jwt, { secret: 'test-secret-with-sufficient-entropy' })
  await app.register(multipart)
  await app.register(adminApi, { prefix: '/admin' })
  await app.ready()

  const [owner] = await db.insert(users).values({ email: 'admin@example.test', passwordHash: 'unused', role: 'admin', createdAt: Date.now() }).returning()
  for (const role of ROLES) {
    const generated = generateApiToken()
    await db.insert(apiTokens).values({ name: role, tokenHash: generated.hash, prefix: generated.prefix, role, userId: owner!.id, createdAt: Date.now() })
    tokens[role] = generated.token
  }
})

after(async () => {
  await app.close()
  teardownTestDb(testDb)
})

/** `/monitors/{id}` in the spec is `/admin/monitors/:id` in the router. */
const routerUrl = (path: string) => `/admin${path.replace(/\{(\w+)\}/g, ':$1')}`
const methodsOf = (route: RouteOptions) => [route.method].flat().map((method) => method.toLowerCase())
/** A route registered as `/` under a prefix is `/admin/monitors/` in the router. */
const withoutTrailingSlash = (url: string) => (url.length > 1 ? url.replace(/\/$/, '') : url)

describe('openapi.yaml', () => {
  it('describes a meaningful part of the API', () => {
    assert.ok(operations.length >= 30, `only ${operations.length} operations`)
  })

  it('documents only routes that exist and that accept an API token', () => {
    for (const { path, method } of operations) {
      const route = routes.find((candidate) => withoutTrailingSlash(candidate.url) === routerUrl(path) && methodsOf(candidate).includes(method))
      assert.ok(route, `${method.toUpperCase()} ${path} is documented but not routed`)
      assert.equal(route.config?.allowApiToken, true, `${method.toUpperCase()} ${path} refuses API tokens`)
    }
  })

  it('has a summary, a success response and a known role on every operation', () => {
    for (const { path, method, operation } of operations) {
      const label = `${method.toUpperCase()} ${path}`
      assert.ok(operation.summary, `${label}: no summary`)
      assert.ok(ROLES.includes(operation['x-role'] ?? ''), `${label}: x-role must be one of ${ROLES.join(', ')}`)
      assert.ok(Object.keys(operation.responses ?? {}).some((status) => status.startsWith('2')), `${label}: no 2xx response`)
    }
  })

  it('declares every path parameter', () => {
    for (const { path, item, operation } of operations) {
      const declared = [...(item.parameters ?? []), ...((operation.parameters ?? []) as Array<{ name?: string; $ref?: string }>)]
        .map((parameter) => parameter.name ?? spec.components.parameters[(parameter.$ref ?? '').split('/').pop() ?? '']?.name)
      for (const [, name] of path.matchAll(/\{(\w+)\}/g)) assert.ok(declared.includes(name), `${path}: {${name}} is not declared`)
    }
  })

  it('only references things that exist', () => {
    const missing: string[] = []
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          const target = value.replace(/^#\//, '').split('/').reduce<unknown>((current, part) => (current as Record<string, unknown> | undefined)?.[part], spec)
          if (target === undefined) missing.push(value)
        } else walk(value)
      }
    }
    walk(spec)
    assert.deepEqual(missing, [])
  })

  it('names the role the router really requires', async () => {
    // A token below the documented role is refused before the handler runs, so this changes nothing.
    for (const { path, method, operation } of operations.filter((o) => o.operation['x-role'] === 'operator')) {
      const url = routerUrl(path).replace(/:\w+/g, '1')
      const response = await app.inject({ method: method.toUpperCase() as 'GET', url, headers: { authorization: `Bearer ${tokens['branding']}` }, payload: method === 'get' ? undefined : {} })
      assert.equal(response.statusCode, 403, `${method.toUpperCase()} ${path} (x-role ${operation['x-role']}) let a branding token in`)
    }
  })
})

describe('openapi.yaml location', () => {
  it('is served with the documentation site', () => {
    assert.ok(SPEC_PATH.endsWith(join('docs', 'public', 'openapi.yaml')))
  })
})
