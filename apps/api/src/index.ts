import 'dotenv/config'
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

import { authRoutes } from './routes/auth.js'
import { monitorRoutes } from './routes/monitors.js'
import { groupRoutes } from './routes/groups.js'
import { incidentRoutes } from './routes/incidents.js'
import { layoutRoutes } from './routes/layout.js'
import { brandingRoutes } from './routes/branding.js'
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

// Auth middleware for admin routes
async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
}

// Routes
await app.register(authRoutes, { prefix: '/api/v1/auth' })
await app.register(publicRoutes, { prefix: '/api/v1/public' })

// Admin routes (protected)
await app.register(async (adminApp) => {
  adminApp.addHook('preHandler', requireAuth)
  await adminApp.register(monitorRoutes, { prefix: '/monitors' })
  await adminApp.register(groupRoutes, { prefix: '/groups' })
  await adminApp.register(incidentRoutes, { prefix: '/incidents' })
  await adminApp.register(layoutRoutes, { prefix: '/layout' })
  await adminApp.register(brandingRoutes, { prefix: '/branding' })
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

startScheduler()
