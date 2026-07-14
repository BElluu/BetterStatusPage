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
import { closeDb, initDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { setupRoutes } from './routes/setup.js'
import { authRoutes } from './routes/auth.js'
import { monitorRoutes } from './routes/monitors.js'
import { incidentRoutes } from './routes/incidents.js'
import { layoutRoutes } from './routes/layout.js'
import { brandingRoutes } from './routes/branding.js'
import { userRoutes } from './routes/users.js'
import { vaultRoutes } from './routes/vaults.js'
import { notificationRoutes } from './routes/notifications.js'
import { maintenanceRoutes } from './routes/maintenance.js'
import { auditRoutes } from './routes/audit.js'
import { publicRoutes } from './routes/public.js'
import { publicLocaleRoutes, adminLocaleRoutes } from './routes/locales.js'
import { webhookRoutes } from './routes/webhook.js'
import { requireAuth, requireRole } from './middleware/auth.js'
import { uploadDir } from './config.js'
import { backupRoutes } from './routes/backups.js'
import { acquireAppLock } from './services/appLock.js'
import { startBackgroundServices, stopBackgroundServices } from './services/backgroundServices.js'
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
  },
  trustProxy: resolveTrustProxy(),
})

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
app.addHook('onSend', (_req, reply, _payload, done) => {
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('X-Frame-Options', 'DENY')
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  reply.header('Cross-Origin-Opener-Policy', 'same-origin')
  reply.header('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
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
await app.register(publicLocaleRoutes, { prefix: '/api/v1/public/locales' })
await app.register(webhookRoutes, { prefix: '/api/v1/hook' })

await app.register(async (adminApp) => {
  adminApp.addHook('preHandler', requireAuth)

  // monitors: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(monitorRoutes, { prefix: '/monitors' })
  })

  // incidents: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(incidentRoutes, { prefix: '/incidents' })
  })

  // layout, branding & locales: branding+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator', 'branding'))
    await sub.register(layoutRoutes,      { prefix: '/layout' })
    await sub.register(brandingRoutes,    { prefix: '/branding' })
    await sub.register(adminLocaleRoutes, { prefix: '/locales' })
  })

  // notifications: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(notificationRoutes, { prefix: '/notifications' })
  })

  // maintenance windows: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(maintenanceRoutes, { prefix: '/maintenance' })
  })

  // users, vaults & audit log: admin only
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole())  // only admin passes (no allowed list)
    await sub.register(userRoutes,   { prefix: '/users' })
    await sub.register(vaultRoutes,  { prefix: '/vaults' })
    await sub.register(auditRoutes,  { prefix: '/audit' })
    await sub.register(backupRoutes, { prefix: '/backups' })
  })
}, { prefix: '/api/v1/admin' })

// Serve built frontend apps in production
if (process.env['NODE_ENV'] === 'production') {
  const adminDist = path.join(__dirname, '../../admin/dist')
  const statusDist = path.join(__dirname, '../../status/dist')

  await registerProductionFrontends(app, adminDist, statusDist)
}

const port = Number(process.env['PORT'] ?? 3000)
const releaseAppLock = acquireAppLock()
let runtimeCleanedUp = false
function cleanupRuntime(): void {
  if (runtimeCleanedUp) return
  runtimeCleanedUp = true
  sseService.closeAll()
  stopBackgroundServices()
  closeDb()
  releaseAppLock()
}
app.addHook('onClose', async () => {
  cleanupRuntime()
})
try {
  await app.listen({ port, host: '0.0.0.0' })
} catch (error) {
  cleanupRuntime()
  throw error
}
console.log(`✓ API running on http://localhost:${port}`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    const forceExit = setTimeout(() => {
      cleanupRuntime()
      process.exit(1)
    }, 5_000)
    forceExit.unref()

    cleanupRuntime()
    app.close()
      .then(() => {
        clearTimeout(forceExit)
        cleanupRuntime()
        process.exit(0)
      })
      .catch(() => {
        clearTimeout(forceExit)
        cleanupRuntime()
        process.exit(1)
      })
  })
}

if (isSetupComplete()) {
  startBackgroundServices()
}
