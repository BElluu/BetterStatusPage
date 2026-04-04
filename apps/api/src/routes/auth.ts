import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>('/login', async (req, reply) => {
    const { email, password } = req.body
    const results = await db.select().from(users).where(eq(users.email, email))
    const user = results[0]
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' })
    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) return reply.code(401).send({ error: 'Invalid credentials' })
    const mustChangePassword = !!user.mustChangePassword
    const token = app.jwt.sign({ userId: user.id, email: user.email, role: user.role })
    return { token, email: user.email, role: user.role, mustChangePassword }
  })

  // Change password — requires valid JWT (obtained at login)
  app.post<{ Body: { newPassword: string } }>('/change-password', {
    preHandler: async (req, reply) => {
      try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Unauthorized' }) }
    },
  }, async (req, reply) => {
    const { newPassword } = req.body
    if (!newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }
    const jwtPayload = req.user as { userId: number; email: string; role: string }
    const hash = await bcrypt.hash(newPassword, 10)
    await db.update(users).set({ passwordHash: hash, mustChangePassword: 0 }).where(eq(users.id, jwtPayload.userId))
    const token = app.jwt.sign({ userId: jwtPayload.userId, email: jwtPayload.email, role: jwtPayload.role })
    return { token }
  })
}
