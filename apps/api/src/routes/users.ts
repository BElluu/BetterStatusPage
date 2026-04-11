import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { normalizeRole } from './auth.js'
import { writeAudit, snapshot } from '../services/audit.js'

const VALID_ROLES = ['admin', 'operator', 'branding'] as const

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let result = ''
  for (let i = 0; i < 12; i++) result += chars[Math.floor(Math.random() * chars.length)]
  return result
}

export async function userRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const all = await db.select({
      id: users.id,
      email: users.email,
      role: users.role,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
    }).from(users)
    return all.map((u) => ({ ...u, role: normalizeRole(u.role) }))
  })

  app.post<{ Body: { email: string } }>('/', async (req, reply) => {
    const { email } = req.body
    if (!email) return reply.code(400).send({ error: 'Email is required' })
    const existing = await db.select().from(users).where(eq(users.email, email))
    if (existing.length > 0) return reply.code(409).send({ error: 'User with this email already exists' })
    const temporaryPassword = generateTempPassword()
    const hash = await bcrypt.hash(temporaryPassword, 10)
    const result = await db.insert(users).values({
      email, passwordHash: hash, role: 'branding', mustChangePassword: 1, createdAt: Date.now(),
    }).returning({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })
    const actor = req.user as { userId: number; email: string }
    writeAudit({ userId: actor.userId, userEmail: actor.email }, 'create', 'user', result[0]!.id, email,
      snapshot({ email, role: 'branding' }))
    return { ...result[0], temporaryPassword }
  })

  app.patch<{ Params: { id: string }; Body: { role: string } }>('/:id/role', async (req, reply) => {
    const id = Number(req.params.id)
    const jwt = req.user as { userId: number }
    if (jwt.userId === id) return reply.code(400).send({ error: 'Cannot change your own role' })
    if (!(VALID_ROLES as readonly string[]).includes(req.body.role)) {
      return reply.code(400).send({ error: 'Invalid role' })
    }
    const existing = (await db.select().from(users).where(eq(users.id, id)))[0]
    const result = await db.update(users).set({ role: req.body.role }).where(eq(users.id, id))
      .returning({ id: users.id, role: users.role })
    if (!result.length) return reply.code(404).send({ error: 'User not found' })
    if (existing) {
      const actor = req.user as { userId: number; email: string }
      writeAudit({ userId: actor.userId, userEmail: actor.email }, 'update', 'user', id, existing.email,
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
    await db.update(users).set({ passwordHash: hash, mustChangePassword: 1 }).where(eq(users.id, id))
    const actor = req.user as { userId: number; email: string }
    writeAudit({ userId: actor.userId, userEmail: actor.email }, 'update', 'user', id, user.email,
      { action: 'password_reset' })
    return { temporaryPassword }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const actor = req.user as { userId: number; email: string }
    if (actor.userId === id) return reply.code(400).send({ error: 'Cannot delete your own account' })
    const existing = (await db.select().from(users).where(eq(users.id, id)))[0]
    await db.delete(users).where(eq(users.id, id))
    if (existing) {
      writeAudit({ userId: actor.userId, userEmail: actor.email }, 'delete', 'user', id, existing.email,
        snapshot({ email: existing.email, role: existing.role }))
    }
    return { success: true }
  })
}
