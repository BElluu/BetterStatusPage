import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import { registerApiRoutes } from '../../src/apiRoutes.js'

type Hook = { allowedRoles?: string[] }

/**
 * The roles a route is limited to ('admin' always passes), or null when it has no role check. Roles come from
 * `requireRole` hooks added to the route's plugin scope (inherited by nested scopes) or listed on the route itself.
 */
export async function describeRouteTable(): Promise<string[]> {
  const app = Fastify({ logger: false })
  const scopeRoles = new Map<FastifyInstance, string[][]>()
  const routes: Array<{ route: RouteOptions; scope: FastifyInstance }> = []

  scopeRoles.set(app, [])
  // Taken before any override: nested scopes inherit the override, so binding `instance.addHook` would call the parent's.
  const baseAddHook = app.addHook as (this: FastifyInstance, name: string, fn: unknown) => unknown
  app.addHook('onRegister', (instance, _opts) => {
    scopeRoles.set(instance, [...(scopeRoles.get(Object.getPrototypeOf(instance) as FastifyInstance) ?? [])])
    ;(instance as { addHook: unknown }).addHook = (name: string, fn: unknown) => {
      const roles = (fn as Hook).allowedRoles
      if (name === 'preHandler' && roles) scopeRoles.get(instance)!.push(roles)
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
    const own = [route.onRequest, route.preHandler].flat().filter(Boolean).flatMap((hook) => ((hook as Hook).allowedRoles ? [(hook as Hook).allowedRoles!] : []))
    const checks = [...(scopeRoles.get(scope) ?? []), ...own]
    const roles = checks.length === 0 ? 'none' : ['admin', ...new Set(checks.flat())].join(',')
    const config = (route.config ?? {}) as { allowApiToken?: boolean; tokenScope?: string }
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    return methods.map((method) => `${method} ${route.url} | token=${config.allowApiToken ? 'yes' : 'no'} | scope=${config.tokenScope ?? '-'} | roles=${roles}`)
  })
  await app.close()
  return [...new Set(rows)].sort()
}
