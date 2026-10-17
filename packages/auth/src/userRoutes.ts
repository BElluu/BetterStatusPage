import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { users } from './tables.js'
import { requestIdentity } from './middleware.js'
import type { AuthOptions } from './context.js'
import type { Sessions } from './sessions.js'
import type { TwoFactor } from './twoFactor.js'
import type { IdentityConfirmation } from './identityConfirmation.js'

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let result = ''
  for (let i = 0; i < 12; i++) result += chars[randomInt(chars.length)]
  return result
}

export function createUserRoutes(ctx: AuthOptions, parts: { sessions: Sessions; twoFactor: TwoFactor; identityConfirmation: IdentityConfirmation }) {
  const { db, roles, audit } = ctx
  const { revokeUserSessions } = parts.sessions
  const { resetTwoFactor } = parts.twoFactor
  const { confirmIdentity } = parts.identityConfirmation

  async function userRoutes(app: FastifyInstance) {
    app.get('/', async () => {
      const all = await db.select({
        id: users.id,
        email: users.email,
        role: users.role,
        mustChangePassword: users.mustChangePassword,
        twoFactorEnabled: users.totpEnabled,
        oidcIssuer: users.oidcIssuer,
        createdAt: users.createdAt,
      }).from(users)
      return all.map(({ mustChangePassword, oidcIssuer, ...u }) => ({
        ...u,
        role: roles.normalize(u.role),
        ssoLinked: !!oidcIssuer,
        // An SSO sign-in revokes the temporary password, so the flag alone is accurate.
        pendingTemporaryPassword: !!mustChangePassword,
      }))
    })

    app.post<{ Body: { email: string; role?: string } }>('/', async (req, reply) => {
      const { email, role = roles.defaultForNewUsers } = req.body
      if (!email) return reply.code(400).send({ error: 'Email is required' })
      if (!roles.isValid(role)) return reply.code(400).send({ error: 'Invalid role' })
      const existing = await db.select().from(users).where(eq(users.email, email))
      if (existing.length > 0) return reply.code(409).send({ error: 'User with this email already exists' })
      const temporaryPassword = generateTempPassword()
      const hash = await bcrypt.hash(temporaryPassword, 10)
      const result = await db.insert(users).values({
        email, passwordHash: hash, role, mustChangePassword: 1, createdAt: Date.now(),
      }).returning({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })
      const actor = requestIdentity(req)
      audit.write(audit.actor(actor), 'create', 'user', result[0]!.id, email,
        audit.snapshot({ email, role }))
      return { ...result[0], temporaryPassword }
    })

    app.patch<{ Params: { id: string }; Body: { role: string } }>('/:id/role', async (req, reply) => {
      const id = Number(req.params.id)
      const jwt = requestIdentity(req)
      if (jwt.userId === id) return reply.code(400).send({ error: 'Cannot change your own role' })
      if (!roles.isValid(req.body.role)) {
        return reply.code(400).send({ error: 'Invalid role' })
      }
      const existing = (await db.select().from(users).where(eq(users.id, id)))[0]
      const result = await db.update(users).set({ role: req.body.role }).where(eq(users.id, id))
        .returning({ id: users.id, role: users.role })
      if (!result.length) return reply.code(404).send({ error: 'User not found' })
      if (existing) {
        await revokeUserSessions(id)
        const actor = requestIdentity(req)
        audit.write(audit.actor(actor), 'update', 'user', id, existing.email,
          { role: { from: existing.role, to: req.body.role } })
      }
      return result[0]
    })

    app.post<{ Params: { id: string } }>('/:id/reset-password', async (req, reply) => {
      const id = Number(req.params.id)
      const user = (await db.select().from(users).where(eq(users.id, id)))[0]
      if (!user) return reply.code(404).send({ error: 'User not found' })
      const temporaryPassword = generateTempPassword()
      const hash = await bcrypt.hash(temporaryPassword, 10)
      await db.update(users).set({
        passwordHash: hash,
        mustChangePassword: 1,
      }).where(eq(users.id, id))
      await revokeUserSessions(id)
      const actor = requestIdentity(req)
      audit.write(audit.actor(actor), 'update', 'user', id, user.email,
        { action: 'password_reset' })
      return { temporaryPassword }
    })

    app.post<{ Params: { id: string }; Body: { currentPassword: string } }>('/:id/reset-2fa', {
      config: { rateLimit: ctx.rateLimits.sensitiveAction },
    }, async (req, reply) => {
      const id = Number(req.params.id)
      const actor = requestIdentity(req)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid user ID' })
      if (actor.userId === id) {
        return reply.code(400).send({ error: 'Use account settings to disable your own two-factor authentication' })
      }

      if (!await confirmIdentity(actor, req.body?.currentPassword, reply)) return reply

      const target = (await db.select().from(users).where(eq(users.id, id)))[0]
      if (!target) return reply.code(404).send({ error: 'User not found' })
      if (!target.totpEnabled) return reply.code(409).send({ error: 'Two-factor authentication is not enabled for this user' })
      if (!await resetTwoFactor(id)) return reply.code(409).send({ error: 'Two-factor authentication is already disabled' })

      await audit.write(
        audit.actor(actor),
        'update', 'user-security', id, target.email,
        { twoFactorReset: { from: true, to: false }, method: 'admin_recovery' },
      )
      return { twoFactorEnabled: false }
    })

    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
      const id = Number(req.params.id)
      const actor = requestIdentity(req)
      if (actor.userId === id) return reply.code(400).send({ error: 'Cannot delete your own account' })
      const existing = (await db.select().from(users).where(eq(users.id, id)))[0]
      await revokeUserSessions(id)
      await db.delete(users).where(eq(users.id, id))
      if (existing) {
        audit.write(audit.actor(actor), 'delete', 'user', id, existing.email,
          audit.snapshot({ email: existing.email, role: existing.role }))
      }
      return { success: true }
    })
  }

  return { userRoutes }
}
