import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'
import fs from 'fs'
import { isSetupComplete, setupConfigPath, writeSetupComplete } from '../config.js'
import { initDb, db } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { startBackgroundServices } from '../services/backgroundServices.js'
import { users, branding, layout } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { SETUP_RATE_LIMIT } from '../config/rateLimits.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { createAuthSession } from '../services/authSession.js'

interface SetupRouteOptions {
  startBackgroundServices?: () => void
}

let setupInProgress = false

export async function setupRoutes(app: FastifyInstance, options: SetupRouteOptions = {}) {
  app.get('/status', async () => {
    return { needsSetup: !isSetupComplete() }
  })

  app.post<{ Body: { email: string; password: string } }>('/complete', {
    config: { rateLimit: SETUP_RATE_LIMIT },
  }, async (req, reply) => {
    if (isSetupComplete()) {
      return reply.code(409).send({ error: 'Setup already completed' })
    }

    const { email, password } = req.body
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' })
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'A valid email address is required' })
    }
    if (password.length < 8 || password.length > 128) {
      return reply.code(400).send({ error: 'Password must be between 8 and 128 characters' })
    }

    if (setupInProgress) {
      return reply.code(409).send({ error: 'Setup is already in progress' })
    }

    setupInProgress = true
    try {
      // Initialize DB and run migrations now that we have a confirmed DB type
      initDb()
      runMigrations()

      const hash = await bcrypt.hash(password, 10)
      let setupMarkerWritten = false
      const user = await withImmediateTransaction(async () => {
        // Setup is not complete, so a row with this email can only be left over from an
        // interrupted attempt — take it over instead of blocking the retry.
        await db.insert(users).values({ email, passwordHash: hash, role: 'admin', createdAt: Date.now() })
          .onConflictDoUpdate({ target: users.email, set: { passwordHash: hash, role: 'admin', mustChangePassword: 0 } })

        const hasBranding = await db.select({ id: branding.id }).from(branding)
        if (hasBranding.length === 0) {
          await db.insert(branding).values({
            id: 1, siteName: 'My Status Page',
            primaryColor: DEFAULT_BRANDING_COLORS.primaryColor, accentColor: DEFAULT_BRANDING_COLORS.accentColor, updatedAt: Date.now(),
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

        const admin = (await db.select().from(users).where(eq(users.email, email)))[0]!
        // Last step: if writing the marker fails the admin insert rolls back with it.
        writeSetupComplete('sqlite')
        setupMarkerWritten = true
        return admin
      }).catch((error: unknown) => {
        // COMMIT itself failed after the marker was written — undo it so setup can be retried.
        if (setupMarkerWritten) fs.rmSync(setupConfigPath(), { force: true })
        throw error
      })
      const startServices = options.startBackgroundServices ?? startBackgroundServices
      startServices()
      const identity = await createAuthSession(app, reply, user)
      const { sessionId: _sessionId, ...safeIdentity } = identity
      return safeIdentity
    } finally {
      setupInProgress = false
    }
  })
}
