import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let result = ''
  for (let i = 0; i < 12; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export async function userRoutes(app: FastifyInstance) {
  // List users (never return passwordHash)
  app.get('/', async () => {
    const all = await db.select({
      id: users.id,
      email: users.email,
      role: users.role,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
    }).from(users)
    return all
  })

  // Create user with generated temp password
  app.post<{ Body: { email: string } }>('/', async (req, reply) => {
    const { email } = req.body
    if (!email) return reply.code(400).send({ error: 'Email is required' })

    const existing = await db.select().from(users).where(eq(users.email, email))
    if (existing.length > 0) return reply.code(409).send({ error: 'User with this email already exists' })

    const temporaryPassword = generateTempPassword()
    const hash = await bcrypt.hash(temporaryPassword, 10)
    const result = await db.insert(users).values({
      email,
      passwordHash: hash,
      role: 'admin',
      mustChangePassword: 1,
      createdAt: Date.now(),
    }).returning({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })

    return { ...result[0], temporaryPassword }
  })

  // Reset user's password (generates new temp password)
  app.post<{ Params: { id: string } }>('/:id/reset-password', async (req, reply) => {
    const id = Number(req.params.id)
    const user = (await db.select().from(users).where(eq(users.id, id)))[0]
    if (!user) return reply.code(404).send({ error: 'User not found' })

    const temporaryPassword = generateTempPassword()
    const hash = await bcrypt.hash(temporaryPassword, 10)
    await db.update(users).set({ passwordHash: hash, mustChangePassword: 1 }).where(eq(users.id, id))
    return { temporaryPassword }
  })

  // Delete user
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const jwtPayload = req.user as { userId: number }
    if (jwtPayload.userId === id) return reply.code(400).send({ error: 'Cannot delete your own account' })
    await db.delete(users).where(eq(users.id, id))
    return { success: true }
  })
}
