import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { db } from '../db/client.js'
import { users, branding, layout } from '../db/schema.js'
import { eq } from 'drizzle-orm'

export async function setupRoutes(app: FastifyInstance) {
  app.get('/status', async () => {
    const existing = await db.select({ id: users.id }).from(users)
    return { needsSetup: existing.length === 0 }
  })

  app.post<{ Body: { email: string; password: string } }>('/complete', async (req, reply) => {
    const existing = await db.select({ id: users.id }).from(users)
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'Setup already completed' })
    }

    const { email, password } = req.body
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' })
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }

    const hash = await bcrypt.hash(password, 10)
    await db.insert(users).values({ email, passwordHash: hash, role: 'admin', createdAt: Date.now() })

    // Seed branding and layout defaults
    const hasBranding = await db.select({ id: branding.id }).from(branding)
    if (hasBranding.length === 0) {
      await db.insert(branding).values({
        id: 1, siteName: 'My Status Page',
        primaryColor: '#6366f1', accentColor: '#f59e0b', updatedAt: Date.now(),
      })
    }
    const hasLayout = await db.select({ id: layout.id }).from(layout)
    if (hasLayout.length === 0) {
      await db.insert(layout).values({
        id: 1,
        tree: JSON.stringify({ id: 'root', type: 'page', children: [] }),
        updatedAt: Date.now(),
      })
    }

    const [user] = await db.select().from(users).where(eq(users.email, email))
    const token = app.jwt.sign({ userId: user!.id, email: user!.email, role: user!.role })
    return { token }
  })
}
