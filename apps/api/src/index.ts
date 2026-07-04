import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import rateLimit from '@fastify/rate-limit'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

import { isSetupComplete } from './config.js'
import { initDb } from './db/client.js'
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
import { startScheduler } from './workers/scheduler.js'
import { requireAuth, requireRole } from './middleware/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: { level: 'info' } })

// CORS
const allowedOrigins = process.env['ALLOWED_ORIGINS']?.split(',').map((o) => o.trim())
await app.register(cors, {
  origin: allowedOrigins
    ?? (process.env['NODE_ENV'] === 'production' ? false : true),
  credentials: true,
})

// JWT
const jwtSecret = process.env['JWT_SECRET']
if (!jwtSecret) {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('JWT_SECRET environment variable must be set in production')
  }
  console.warn('⚠ JWT_SECRET not set — using insecure default (development only)')
}
await app.register(jwt, {
  secret: jwtSecret ?? 'dev-secret-change-me',
})

// Rate limiting (applied per-route where needed)
await app.register(rateLimit, { global: false })

// Multipart (file uploads)
await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
})

// Serve uploaded files
const uploadsDir = path.resolve(process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'data', 'uploads'))
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
  })
}, { prefix: '/api/v1/admin' })

// Serve built frontend apps in production
if (process.env['NODE_ENV'] === 'production') {
  const adminDist = path.join(__dirname, '../../admin/dist')
  const statusDist = path.join(__dirname, '../../status/dist')

  await app.register(staticFiles, {
    root: adminDist,
    prefix: '/admin/',
    decorateReply: false,
  })

  app.get('/admin/*', (_, reply) => reply.sendFile('index.html', adminDist))

  await app.register(staticFiles, {
    root: statusDist,
    prefix: '/',
    decorateReply: false,
  })

  app.setNotFoundHandler((_, reply) => reply.sendFile('index.html', statusDist))
}

const port = Number(process.env['PORT'] ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
console.log(`✓ API running on http://localhost:${port}`)

if (isSetupComplete()) startScheduler()
