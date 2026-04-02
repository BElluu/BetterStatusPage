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
    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    const token = app.jwt.sign({ userId: user.id, email: user.email, role: user.role })
    return { token, email: user.email, role: user.role }
  })
}
