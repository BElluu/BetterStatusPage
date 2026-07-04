import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { isSetupComplete, writeSetupComplete } from '../config.js'
import { initDb, db } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { startScheduler } from '../workers/scheduler.js'
import { users, branding, layout } from '../db/schema.js'
import { eq } from 'drizzle-orm'

interface SetupRouteOptions {
  startScheduler?: () => void
}

export async function setupRoutes(app: FastifyInstance, options: SetupRouteOptions = {}) {
  app.get('/status', async () => {
    return { needsSetup: !isSetupComplete() }
  })

  app.post<{ Body: { email: string; password: string } }>('/complete', async (req, reply) => {
    if (isSetupComplete()) {
      return reply.code(409).send({ error: 'Setup already completed' })
    }

    const { email, password } = req.body
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' })
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }

    // Initialize DB and run migrations now that we have a confirmed DB type
    initDb()
    runMigrations()

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

    // Mark setup as complete and start the monitor scheduler
    writeSetupComplete('sqlite')
    const startMonitoring = options.startScheduler ?? startScheduler
    startMonitoring()

    const [user] = await db.select().from(users).where(eq(users.email, email))
    const token = app.jwt.sign({ userId: user!.id, email: user!.email, role: user!.role })
    return { token }
  })
}
