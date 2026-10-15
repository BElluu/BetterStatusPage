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
