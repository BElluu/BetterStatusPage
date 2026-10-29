import type { FastifyInstance, FastifyReply } from 'fastify'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import type { SqliteDatabase } from '@better-forge/db'
import { users } from './tables.js'

export interface SetupRoutesOptions<Identity extends { sessionId?: string }> {
  db: SqliteDatabase
  /** Runs `work` so that all of it is written, or none of it. */
  withTransaction: <T>(work: () => Promise<T>) => Promise<T>
  isSetupComplete: () => boolean
  /** Records that setup is done. Called as the last step inside the transaction: if it throws, the administrator is not kept. */
  writeSetupComplete: () => void
  /** Takes the record back, when the transaction fails to commit after it was written. */
  removeSetupMarker: () => void
  /** Opens the database and brings its tables up to date; called once the request has been checked. */
  prepareDatabase: () => void
  /** Signs the new administrator in. */
  createSession: (app: FastifyInstance, reply: FastifyReply, user: typeof users.$inferSelect) => Promise<Identity>
  /** Rate limit of `POST /complete` (the config the rate limit plugin understands). */
  rateLimit: Record<string, unknown>
  /** Writes whatever else the application needs on first run, inside the same transaction as the administrator. */
  onSetup?: () => Promise<void>
  /** Starts the work that runs only once the application is set up. */
  startBackgroundServices?: () => void
  /** Lets setup run although accounts already exist, for an installation that is filled with accounts before its first run. Checked on each request. */
  allowExistingUsers?: () => boolean
}

/**
 * The first-run routes: whether the application still needs setup, and the one request that creates the administrator
 * and finishes it. Setup is refused once it is done, and only one attempt runs at a time.
 */
export function createSetupRoutes<Identity extends { sessionId?: string }>(options: SetupRoutesOptions<Identity>) {
  const { db } = options
  let inProgress = false

  return async function setupRoutes(app: FastifyInstance, overrides: { startBackgroundServices?: () => void } = {}) {
    app.get('/status', async () => ({ needsSetup: !options.isSetupComplete() }))

    app.post<{ Body: { email: string; password: string } }>('/complete', {
      config: { rateLimit: options.rateLimit },
    }, async (req, reply) => {
      if (options.isSetupComplete()) {
        return reply.code(409).send({ error: 'Setup already completed' })
      }

      const { email, password } = req.body ?? {}
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' })
      }
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.code(400).send({ error: 'A valid email address is required' })
      }
      if (password.length < 8 || password.length > 128) {
        return reply.code(400).send({ error: 'Password must be between 8 and 128 characters' })
      }

      if (inProgress) {
        return reply.code(409).send({ error: 'Setup is already in progress' })
      }

      inProgress = true
      try {
        // Initialize DB and run migrations now that we have a confirmed DB type
        options.prepareDatabase()

        const hash = await bcrypt.hash(password, 10)
        let setupMarkerWritten = false
        const user = await options.withTransaction(async () => {
          // The marker can be missing while the data is not (a lost volume, a restore). Accounts that already
          // exist mean setup was done: never create or overwrite an administrator over them.
          if (!options.allowExistingUsers?.() && (await db.select({ id: users.id }).from(users).limit(1)).length > 0) return null

          await db.insert(users).values({ email, passwordHash: hash, role: 'admin', createdAt: Date.now() })

          await options.onSetup?.()

          const admin = (await db.select().from(users).where(eq(users.email, email)))[0]!
          // Last step: if writing the marker fails the admin insert rolls back with it.
          options.writeSetupComplete()
          setupMarkerWritten = true
          return admin
        }).catch((error: unknown) => {
          // COMMIT itself failed after the marker was written — undo it so setup can be retried.
          if (setupMarkerWritten) options.removeSetupMarker()
          throw error
        })
        if (!user) return reply.code(409).send({ error: 'Setup already completed' })
        const startServices = overrides.startBackgroundServices ?? options.startBackgroundServices
        startServices?.()
        const identity = await options.createSession(app, reply, user)
        const { sessionId: _sessionId, ...safeIdentity } = identity
        return safeIdentity
      } finally {
        inProgress = false
      }
    })
  }
}
