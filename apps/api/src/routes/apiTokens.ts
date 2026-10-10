import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { apiTokens, users } from '../db/schema.js'
import { requestIdentity } from '../middleware/auth.js'
import { auditActor, snapshot, writeAudit } from '../services/audit.js'
import { API_TOKEN_ROLES, generateApiToken, type ApiTokenRole } from '../services/apiTokens.js'
import { sseService } from '../services/sse.service.js'

const MAX_NAME_LENGTH = 80
const MAX_EXPIRY_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

export async function apiTokenRoutes(app: FastifyInstance) {
  type TokenRow = typeof apiTokens.$inferSelect

  function publicToken(row: TokenRow, createdBy: string) {
    const { tokenHash: _tokenHash, ...rest } = row
    return { ...rest, createdBy }
  }

  app.get('/', async () => {
    const [rows, owners] = await Promise.all([
      db.select().from(apiTokens),
      db.select({ id: users.id, email: users.email }).from(users),
    ])
    const emails = new Map(owners.map((u) => [u.id, u.email]))
    return rows.map((row) => publicToken(row, emails.get(row.userId) ?? ''))
  })

  app.post<{ Body: { name?: unknown; role?: unknown; expiresInDays?: unknown } }>('/', async (req, reply) => {
    const { name, role, expiresInDays } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LENGTH) {
      return reply.code(400).send({ error: `Name is required (up to ${MAX_NAME_LENGTH} characters)` })
    }
    if (!API_TOKEN_ROLES.includes(role as ApiTokenRole)) {
      return reply.code(400).send({ error: `Role must be one of: ${API_TOKEN_ROLES.join(', ')}` })
    }
    if (expiresInDays !== undefined && expiresInDays !== null
      && (!Number.isInteger(expiresInDays) || (expiresInDays as number) < 1 || (expiresInDays as number) > MAX_EXPIRY_DAYS)) {
      return reply.code(400).send({ error: `expiresInDays must be a whole number from 1 to ${MAX_EXPIRY_DAYS}, or empty for no expiry` })
    }

    const identity = requestIdentity(req)
    const now = Date.now()
    const generated = generateApiToken()
    const row = (await db.insert(apiTokens).values({
      name: name.trim(),
      tokenHash: generated.hash,
      prefix: generated.prefix,
      role: role as ApiTokenRole,
      userId: identity.userId,
      createdAt: now,
      expiresAt: typeof expiresInDays === 'number' ? now + expiresInDays * DAY_MS : null,
    }).returning())[0]!
    await writeAudit(auditActor(identity), 'create', 'api_token', row.id, row.name,
      snapshot({ name: row.name, role: row.role, prefix: row.prefix, expiresAt: row.expiresAt }))
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
      snapshot({ name: existing.name, role: existing.role, prefix: existing.prefix }))
    return reply.code(204).send()
  })
}
