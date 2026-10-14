import type { FastifyInstance } from 'fastify'
import { adminApi } from './adminApi.js'
import { setupRoutes } from './routes/setup.js'
import { authRoutes } from './routes/auth.js'
import { publicRoutes } from './routes/public.js'
import { publicLocaleRoutes } from './routes/locales.js'
import { webhookRoutes } from './routes/webhook.js'
import { publicSubscriptionRoutes } from './routes/subscriptions.js'
import { feedRoutes } from './routes/feeds.js'
import { statusApiRoutes } from './routes/statusApi.js'
import { publicStatusPageAccessRoutes } from './routes/statusPageAccess.js'
import { healthRoutes } from './routes/health.js'

/**
 * Every HTTP route of the API. Registered by index.ts; kept in its own module so a test can build the real route
 * table and snapshot it.
 */
export async function registerApiRoutes(app: FastifyInstance) {
  await app.register(healthRoutes)
  await app.register(setupRoutes, { prefix: '/api/v1/setup' })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(publicRoutes, { prefix: '/api/v1/public' })
  await app.register(publicStatusPageAccessRoutes, { prefix: '/api/v1/public' })
  await app.register(publicLocaleRoutes, { prefix: '/api/v1/public/locales' })
  await app.register(webhookRoutes, { prefix: '/api/v1/hook' })
  await app.register(feedRoutes, { prefix: '/api/v1/public' })
  await app.register(statusApiRoutes, { prefix: '/api/v1/public' })
  await app.register(publicSubscriptionRoutes, { prefix: '/api/v1/public/subscriptions' })

  await app.register(adminApi, { prefix: '/api/v1/admin' })
}
