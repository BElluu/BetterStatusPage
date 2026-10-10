import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

import { isSetupComplete } from './config.js'
import { errorHandler } from './errorHandler.js'
import { closeDb, initDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
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
import { uploadDir } from './config.js'
import { acquireAppLock } from './services/appLock.js'
import { startBackgroundServices, stopBackgroundServices } from './services/backgroundServices.js'
import { createRuntimeShutdown } from './services/shutdown.js'
import { JWT_EXPIRES_IN, resolveJwtSecret, validateVaultEncryptionKey } from './config/secrets.js'
import { healthRoutes } from './routes/health.js'
import { resolveTrustProxy } from './config/proxy.js'
import { sseService } from './services/sse.service.js'
import { registerProductionFrontends } from './services/productionFallback.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = Fastify({
  logger: {
    level: 'info',
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    serializers: {
      // One-click unsubscribe links carry their capability token in the query string.
      req: (req) => ({
        method: req.method,
        url: req.url.replace(/([?&]token=)[^&]*/gi, '$1[redacted]'),
        host: req.host,
        remoteAddress: req.ip,
        ...(req.socket?.remotePort !== undefined ? { remotePort: req.socket.remotePort } : {}),
      }),
    },
  },
  trustProxy: resolveTrustProxy(),
})

app.setErrorHandler(errorHandler)

// CORS
const allowedOrigins = process.env['ALLOWED_ORIGINS']?.split(',').map((o) => o.trim())
await app.register(cors, {
  origin: allowedOrigins
    ?? (process.env['NODE_ENV'] === 'production' ? false : true),
  credentials: true,
})

await app.register(cookie)

// Reject unsafe cross-site browser requests before they reach auth or setup routes.
app.addHook('onRequest', async (req, reply) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return
  if (process.env['NODE_ENV'] !== 'production') return
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return reply.code(403).send({ error: 'Cross-site request rejected' })
  }
  const origin = req.headers.origin
  if (!origin) return
  const ownOrigin = `${req.protocol}://${req.headers.host}`
  if (origin !== ownOrigin && !allowedOrigins?.includes(origin)) {
    return reply.code(403).send({ error: 'Origin not allowed' })
  }
})

// JWT
const jwtSecret = resolveJwtSecret()
validateVaultEncryptionKey()
await app.register(jwt, {
  secret: jwtSecret,
  sign: { expiresIn: JWT_EXPIRES_IN },
})

// Rate limiting (applied per-route where needed)
await app.register(rateLimit, { global: false })

// Multipart (file uploads)
await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
})

// Serve uploaded files
const uploadsDir = uploadDir()
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}
await app.register(staticFiles, {
  root: uploadsDir,
  prefix: '/uploads/',
  decorateReply: false,
})

// Security headers
app.addHook('onSend', (req, reply, _payload, done) => {
  const [requestPath, query = ''] = req.url.split('?', 2)
  const isBrandingPreview = requestPath === '/'
    && new URLSearchParams(query).get('branding-preview') === '1'
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('X-Frame-Options', isBrandingPreview ? 'SAMEORIGIN' : 'DENY')
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  reply.header('Cross-Origin-Opener-Policy', 'same-origin')
  reply.header('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    isBrandingPreview ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
  ].join('; '))
  if (process.env['NODE_ENV'] === 'production') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  done()
})

// Initialize DB only when setup has been completed
if (isSetupComplete()) {
  initDb()
  runMigrations()
}

// Routes
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

// Serve built frontend apps in production
if (process.env['NODE_ENV'] === 'production') {
  const adminDist = path.join(__dirname, '../../admin/dist')
  const statusDist = path.join(__dirname, '../../status/dist')

  await registerProductionFrontends(app, adminDist, statusDist)
}

const port = Number(process.env['PORT'] ?? 3000)
const releaseAppLock = acquireAppLock()
const runtime = createRuntimeShutdown({
  stopIntake: () => {
    sseService.closeAll()
    stopBackgroundServices()
  },
  closeServer: () => app.close(),
  releaseResources: () => {
    closeDb()
    releaseAppLock()
  },
  exit: (code) => process.exit(code),
})
// onClose runs after the HTTP server has drained, so the DB is no longer in use.
app.addHook('onClose', async () => {
  runtime.cleanup()
})
try {
  await app.listen({ port, host: '0.0.0.0' })
} catch (error) {
  runtime.cleanup()
  throw error
}
console.log(`✓ API running on http://localhost:${port}`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, runtime.shutdown)
}

if (isSetupComplete()) {
  startBackgroundServices()
}
