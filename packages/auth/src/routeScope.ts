import type { FastifyInstance } from 'fastify'

/**
 * Marks every route registered in `scope` as belonging to a part of the API, which is what an API token is checked
 * against (`<part>:read` for GET, `<part>:write` otherwise). A route without a part is refused to every token.
 */
export function belongsTo(scope: FastifyInstance, part: string): void {
  scope.addHook('onRoute', (route) => { route.config = { ...route.config, tokenScope: part } })
}

/** Lets (or, with `false`, stops) the routes registered in `scope` accept an API token. Routes accept none by default. */
export function acceptApiTokens(scope: FastifyInstance, accept = true): void {
  scope.addHook('onRoute', (route) => { route.config = { ...route.config, allowApiToken: accept } })
}

type RoutePlugin = (scope: FastifyInstance) => Promise<void> | void
type Guard = (...args: never[]) => unknown

/** A group of routes that share a guard and, usually, a part of the API tokens are checked against. */
export interface AdminRouteGroup {
  /** The part of the API the routes belong to. Omit it for a group whose routes no token reaches. */
  part?: string
  /** The group refuses API tokens even though the rest of the API accepts them. */
  noTokens?: boolean
  /** Runs before every route of the group (the role the group needs). */
  guard: Guard
  /** The route plugins of the group with the prefix each is mounted at. */
  routes: ReadonlyArray<readonly [plugin: RoutePlugin, options: { prefix: string }]>
}

/**
 * Registers the admin API: the scope accepts API tokens and needs a signed-in caller (`authenticate`), then every group
 * gets its own scope with its part, its guard and its routes. A token is checked against the part of the group a route
 * is in; a group with `noTokens` is for what a leaked token must never reach.
 */
export async function registerAdminApi(
  adminApp: FastifyInstance,
  options: { authenticate: Guard; groups: readonly AdminRouteGroup[] },
): Promise<void> {
  acceptApiTokens(adminApp)
  adminApp.addHook('preHandler', options.authenticate as never)
  for (const group of options.groups) {
    await adminApp.register(async (scope) => {
      if (group.noTokens) acceptApiTokens(scope, false)
      if (group.part !== undefined) belongsTo(scope, group.part)
      scope.addHook('preHandler', group.guard as never)
      for (const [plugin, routeOptions] of group.routes) await scope.register(plugin, routeOptions)
    })
  }
}
