import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const VALID_ROLES = ['admin', 'operator', 'branding'] as const

/** Normalize stored role value — handles legacy JSON arrays and old role names. */
export function normalizeRole(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    const first: string = Array.isArray(parsed) ? (parsed[0] ?? 'branding') : raw
    return (VALID_ROLES as readonly string[]).includes(first) ? first : 'branding'
  } catch {
    return (VALID_ROLES as readonly string[]).includes(raw) ? raw : 'branding'
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>('/login', async (req, reply) => {
    const { email, password } = req.body
    const results = await db.select().from(users).where(eq(users.email, email))
    const user = results[0]
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' })
    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) return reply.code(401).send({ error: 'Invalid credentials' })
    const mustChangePassword = !!user.mustChangePassword
    const role = normalizeRole(user.role)
    const token = app.jwt.sign({ userId: user.id, email: user.email, role })
    return { token, email: user.email, role, mustChangePassword }
  })

  app.post<{ Body: { newPassword: string; currentPassword?: string } }>('/change-password', {
    preHandler: async (req, reply) => {
      try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Unauthorized' }) }
    },
  }, async (req, reply) => {
    const { newPassword, currentPassword } = req.body
    if (!newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }
    const jwt = req.user as { userId: number; email: string; role: string }
    const user = (await db.select().from(users).where(eq(users.id, jwt.userId)))[0]
    if (!user) return reply.code(404).send({ error: 'User not found' })

    // Voluntary password change (not forced) requires current password verification
    if (!user.mustChangePassword) {
      if (!currentPassword) return reply.code(400).send({ error: 'Current password is required' })
      const valid = await bcrypt.compare(currentPassword, user.passwordHash)
      if (!valid) return reply.code(400).send({ error: 'Current password is incorrect' })
    }

    const hash = await bcrypt.hash(newPassword, 10)
    await db.update(users).set({ passwordHash: hash, mustChangePassword: 0 }).where(eq(users.id, jwt.userId))
    const token = app.jwt.sign({ userId: jwt.userId, email: jwt.email, role: jwt.role })
    return { token }
  })
}
