import 'dotenv/config'
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

import { isSetupComplete } from './config.js'
import { initDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { setupRoutes } from './routes/setup.js'
import { authRoutes } from './routes/auth.js'
import { monitorRoutes } from './routes/monitors.js'
import { groupRoutes } from './routes/groups.js'
import { incidentRoutes } from './routes/incidents.js'
import { layoutRoutes } from './routes/layout.js'
import { brandingRoutes } from './routes/branding.js'
import { userRoutes } from './routes/users.js'
import { publicRoutes } from './routes/public.js'
import { startScheduler } from './workers/scheduler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: { level: 'info' } })

// CORS
await app.register(cors, {
  origin: true,
  credentials: true,
})

// JWT
await app.register(jwt, {
  secret: process.env['JWT_SECRET'] ?? 'dev-secret-change-me',
})

// Multipart (file uploads)
await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
})

// Serve uploaded files
const uploadsDir = process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'data', 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}
await app.register(staticFiles, {
  root: uploadsDir,
  prefix: '/uploads/',
  decorateReply: false,
})

// Auth middleware
async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify() } catch { return reply.code(401).send({ error: 'Unauthorized' }) }
}

// role hierarchy: admin > operator > branding
function requireRole(...allowed: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify()
      const { role } = req.user as { role: string }
      if (role !== 'admin' && !allowed.includes(role)) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
    } catch { return reply.code(401).send({ error: 'Unauthorized' }) }
  }
}

// Initialize DB only when setup has been completed
if (isSetupComplete()) {
  initDb()
  runMigrations()
}

// Routes
await app.register(setupRoutes, { prefix: '/api/v1/setup' })
await app.register(authRoutes, { prefix: '/api/v1/auth' })
await app.register(publicRoutes, { prefix: '/api/v1/public' })

await app.register(async (adminApp) => {
  adminApp.addHook('preHandler', requireAuth)

  // monitors & groups: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(monitorRoutes, { prefix: '/monitors' })
    await sub.register(groupRoutes,   { prefix: '/groups' })
  })

  // incidents: operator+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator'))
    await sub.register(incidentRoutes, { prefix: '/incidents' })
  })

  // layout & branding: branding+
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole('operator', 'branding'))
    await sub.register(layoutRoutes,   { prefix: '/layout' })
    await sub.register(brandingRoutes, { prefix: '/branding' })
  })

  // users: admin only
  await adminApp.register(async (sub) => {
    sub.addHook('preHandler', requireRole())  // only admin passes (no allowed list)
    await sub.register(userRoutes, { prefix: '/users' })
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
