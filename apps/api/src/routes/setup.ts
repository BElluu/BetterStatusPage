import fs from 'fs'
import { createSetupRoutes } from '@better-kit/auth'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'
import { isSetupComplete, setupConfigPath, writeSetupComplete } from '../config.js'
import { initDb, db } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { startBackgroundServices } from '../services/backgroundServices.js'
import { branding, layout } from '../db/schema.js'
import { SETUP_RATE_LIMIT } from '../config/rateLimits.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { createAuthSession } from '../kit/authSession.js'

/** First-run setup: the administrator account (by the auth package) and the status page the product starts with. */
export const setupRoutes = createSetupRoutes({
  db,
  withTransaction: withImmediateTransaction,
  isSetupComplete: () => isSetupComplete(),
  writeSetupComplete: () => writeSetupComplete('sqlite'),
  removeSetupMarker: () => fs.rmSync(setupConfigPath(), { force: true }),
  // Initialize DB and run migrations now that we have a confirmed DB type
  prepareDatabase: () => { initDb(); runMigrations() },
  createSession: (app, reply, user) => createAuthSession(app, reply, user),
  rateLimit: SETUP_RATE_LIMIT,
  async onSetup() {
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
  },
  startBackgroundServices,
})
