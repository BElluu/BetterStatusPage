import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { normalizeScopes } from '@bsp/shared'
import { db } from '../db/client.js'
import { apiTokens, users } from '../db/schema.js'
import { requestIdentity } from '../middleware/auth.js'
import { auditActor, snapshot, writeAudit } from '../services/audit.js'
import { generateApiToken, parseScopes } from '../services/apiTokens.js'
import { sseService } from '../services/sse.service.js'

const MAX_NAME_LENGTH = 80
const MAX_EXPIRY_DAYS = 3650
/** A token that nobody asked to live forever should not. */
const DEFAULT_EXPIRY_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export async function apiTokenRoutes(app: FastifyInstance) {
  type TokenRow = typeof apiTokens.$inferSelect

  function publicToken(row: TokenRow, createdBy: string) {
    const { tokenHash: _tokenHash, scopes, ...rest } = row
    return { ...rest, scopes: parseScopes(scopes), createdBy }
  }

  app.get('/', async () => {
    const [rows, owners] = await Promise.all([
      db.select().from(apiTokens),
      db.select({ id: users.id, email: users.email }).from(users),
    ])
    const emails = new Map(owners.map((u) => [u.id, u.email]))
    return rows.map((row) => publicToken(row, emails.get(row.userId) ?? ''))
  })

  // `expiresInDays` left out means the default; `null` is the explicit "never".
  app.post<{ Body: { name?: unknown; scopes?: unknown; expiresInDays?: unknown } }>('/', async (req, reply) => {
    const { name, scopes: requested, expiresInDays } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LENGTH) {
      return reply.code(400).send({ error: `Name is required (up to ${MAX_NAME_LENGTH} characters)` })
    }
    const scopes = normalizeScopes(requested)
    if (!scopes) return reply.code(400).send({ error: 'scopes must be a list with at least one known permission' })
    if (expiresInDays !== undefined && expiresInDays !== null
      && (!Number.isInteger(expiresInDays) || (expiresInDays as number) < 1 || (expiresInDays as number) > MAX_EXPIRY_DAYS)) {
      return reply.code(400).send({ error: `expiresInDays must be a whole number from 1 to ${MAX_EXPIRY_DAYS}, or null for no expiry` })
    }

    const identity = requestIdentity(req)
    const now = Date.now()
    const generated = generateApiToken()
    const days = expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : expiresInDays
    const row = (await db.insert(apiTokens).values({
      name: name.trim(),
      tokenHash: generated.hash,
      prefix: generated.prefix,
      scopes: JSON.stringify(scopes),
      userId: identity.userId,
      createdAt: now,
      expiresAt: typeof days === 'number' ? now + days * DAY_MS : null,
    }).returning())[0]!
    await writeAudit(auditActor(identity), 'create', 'api_token', row.id, row.name,
      snapshot({ name: row.name, permissions: scopes.join(', '), prefix: row.prefix, expiresAt: row.expiresAt }))
    // The only time the plaintext token leaves the server.
    return { ...publicToken(row, identity.email), token: generated.token }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = Number.isSafeInteger(id) ? (await db.select().from(apiTokens).where(eq(apiTokens.id, id)))[0] : undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    await db.delete(apiTokens).where(eq(apiTokens.id, id))
    // A live event stream opened with the token must not outlast it.
    sseService.disconnectSessions((session) => session.sessionId === `api-token:${id}`)
    await writeAudit(auditActor(requestIdentity(req)), 'delete', 'api_token', id, existing.name,
      snapshot({ name: existing.name, permissions: parseScopes(existing.scopes).join(', '), prefix: existing.prefix }))
    return reply.code(204).send()
  })
}
