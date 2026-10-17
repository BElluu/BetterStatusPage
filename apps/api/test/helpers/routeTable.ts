import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import { registerApiRoutes } from '../../src/apiRoutes.js'

type Hook = { allowedRoles?: string[]; requiresAuth?: boolean }

/**
 * For every route: whether it needs a signed-in caller (`requireAuth`, or `requireRole` which implies it) and the roles
 * it is limited to ('admin' always passes). They come from hooks added to the route's plugin scope (inherited by nested
 * scopes) or listed on the route itself.
 */
export async function describeRouteTable(): Promise<string[]> {
  const app = Fastify({ logger: false })
  const scopeHooks = new Map<FastifyInstance, Hook[]>()
  const routes: Array<{ route: RouteOptions; scope: FastifyInstance }> = []

  scopeHooks.set(app, [])
  // Taken before any override: nested scopes inherit the override, so binding `instance.addHook` would call the parent's.
  const baseAddHook = app.addHook as (this: FastifyInstance, name: string, fn: unknown) => unknown
  app.addHook('onRegister', (instance, _opts) => {
    scopeHooks.set(instance, [...(scopeHooks.get(Object.getPrototypeOf(instance) as FastifyInstance) ?? [])])
    ;(instance as { addHook: unknown }).addHook = (name: string, fn: unknown) => {
      const hook = fn as Hook
      if (name === 'preHandler' && (hook.allowedRoles || hook.requiresAuth)) scopeHooks.get(instance)!.push(hook)
      return baseAddHook.call(instance, name, fn)
    }
  })
  app.addHook('onRoute', function (this: FastifyInstance, route) { routes.push({ route, scope: this }) })

  await app.register(cookie)
  await app.register(jwt, { secret: 'route-table-snapshot-secret' })
  await app.register(multipart)
  await registerApiRoutes(app)
  await app.ready()

  const rows = routes.flatMap(({ route, scope }) => {
    const own = [route.onRequest, route.preHandler].flat().filter(Boolean).map((hook) => hook as Hook).filter((hook) => hook.allowedRoles || hook.requiresAuth)
    const checks = [...(scopeHooks.get(scope) ?? []), ...own]
    const limited = checks.flatMap((hook) => hook.allowedRoles ?? [])
    const roles = limited.length === 0 && !checks.some((hook) => hook.allowedRoles) ? 'none' : ['admin', ...new Set(limited)].join(',')
    const config = (route.config ?? {}) as { allowApiToken?: boolean; tokenScope?: string }
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    return methods.map((method) => `${method} ${route.url} | auth=${checks.length > 0 ? 'yes' : 'no'} | token=${config.allowApiToken ? 'yes' : 'no'} | scope=${config.tokenScope ?? '-'} | roles=${roles}`)
  })
  await app.close()
  return [...new Set(rows)].sort()
}
