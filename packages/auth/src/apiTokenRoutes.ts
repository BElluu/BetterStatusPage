import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { apiTokens } from './tables.js'
import { requestIdentity } from './middleware.js'
import type { AuthOptions } from './context.js'
import type { ApiTokens } from './apiTokens.js'
import type { IdentityConfirmation } from './identityConfirmation.js'

const MAX_NAME_LENGTH = 80

const MAX_EXPIRY_DAYS = 3650

/** A token that nobody asked to live forever should not. */
const DEFAULT_EXPIRY_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

export function createApiTokenRoutes(ctx: AuthOptions, tokens: ApiTokens, identityConfirmation: IdentityConfirmation) {
  const { db, audit } = ctx
  const hooks = ctx.hooks ?? {}
  const { generateApiToken, parseScopes } = tokens
  const { confirmIdentity } = identityConfirmation

  async function apiTokenRoutes(app: FastifyInstance) {
    type TokenRow = typeof apiTokens.$inferSelect

    function publicToken(row: TokenRow) {
      const { tokenHash: _tokenHash, scopes, ...rest } = row
      return { ...rest, scopes: parseScopes(scopes) }
    }

    app.get('/', async () => (await db.select().from(apiTokens)).map(publicToken))

    // `expiresInDays` left out means the default; `null` is the explicit "never".
    app.post<{ Body: { name?: unknown; scopes?: unknown; expiresInDays?: unknown; currentPassword?: unknown } }>('/', {
      config: { rateLimit: ctx.rateLimits.sensitiveAction },
    }, async (req, reply) => {
      const { name, scopes: requested, expiresInDays } = req.body ?? {}
      if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LENGTH) {
        return reply.code(400).send({ error: `Name is required (up to ${MAX_NAME_LENGTH} characters)` })
      }
      const scopes = ctx.tokens.normalize(requested)
      if (!scopes) return reply.code(400).send({ error: 'scopes must be a list with at least one known permission' })
      if (expiresInDays !== undefined && expiresInDays !== null
        && (!Number.isInteger(expiresInDays) || (expiresInDays as number) < 1 || (expiresInDays as number) > MAX_EXPIRY_DAYS)) {
        return reply.code(400).send({ error: `expiresInDays must be a whole number from 1 to ${MAX_EXPIRY_DAYS}, or null for no expiry` })
      }

      const identity = requestIdentity(req)
      if (!await confirmIdentity(identity, req.body?.currentPassword, reply)) return reply
      const now = Date.now()
      const generated = generateApiToken()
      const days = expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : expiresInDays
      const row = (await db.insert(apiTokens).values({
        name: name.trim(),
        tokenHash: generated.hash,
        prefix: generated.prefix,
        scopes: JSON.stringify(scopes),
        createdAt: now,
        expiresAt: typeof days === 'number' ? now + days * DAY_MS : null,
      }).returning())[0]!
      await audit.write(audit.actor(identity), 'create', 'api_token', row.id, row.name,
        audit.snapshot({ name: row.name, permissions: scopes.join(', '), prefix: row.prefix, expiresAt: row.expiresAt }))
      // The only time the plaintext token leaves the server.
      return { ...publicToken(row), token: generated.token }
    })

    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const existing = Number.isSafeInteger(id) ? (await db.select().from(apiTokens).where(eq(apiTokens.id, id)))[0] : undefined
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      await db.delete(apiTokens).where(eq(apiTokens.id, id))
      // A live event stream opened with the token must not outlast it.
      hooks.onSessionsRevoked?.({ sessionId: `api-token:${id}` })
      await audit.write(audit.actor(requestIdentity(req)), 'delete', 'api_token', id, existing.name,
        audit.snapshot({ name: existing.name, permissions: parseScopes(existing.scopes).join(', '), prefix: existing.prefix }))
      return reply.code(204).send()
    })
  }

  return { apiTokenRoutes }
}
