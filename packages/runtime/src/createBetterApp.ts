import fs from 'node:fs'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { rateLimitKey } from './rateLimitKey.js'
import staticFiles from '@fastify/static'
import { errorHandler } from './errorHandler.js'
import { redactUrl } from './redactUrl.js'
import { resolveTrustProxy } from './proxy.js'
import { createRuntimeShutdown } from './shutdown.js'

const DEFAULT_JWT_SECRET = 'dev-secret-change-me'
const EXAMPLE_SECRETS = new Set([
  'change-me-to-a-long-random-string',
  'change-me-to-a-64-char-hex-string',
])

/** How long a signed-in session token lives. */
export const JWT_EXPIRES_IN = '12h'

/** The secret sessions are signed with: from `JWT_SECRET`, which production insists on being a real one. */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env['JWT_SECRET']
  if (env['NODE_ENV'] !== 'production') {
    if (!secret) console.warn('JWT_SECRET not set - using insecure default (development only)')
    return secret ?? DEFAULT_JWT_SECRET
  }
  if (!secret || secret.length < 32 || EXAMPLE_SECRETS.has(secret)) {
    throw new Error('JWT_SECRET must be set to a non-default value of at least 32 characters in production')
  }
  return secret
}

export interface BetterAppOptions {
  /** Request URLs are logged with the value of these query parameters replaced (capability tokens in links). */
  redactQueryParams?: readonly string[]
  /** Request paths whose next segment is a capability token, for example `/links/` (the token is not logged). */
  redactPathTokenPrefixes?: readonly string[]
  /** Checks run before anything is created (for example that the encryption key is usable); throw to refuse to start. */
  validate?: () => void
  /** Where uploaded files are kept and served from (`/uploads/`). */
  uploads: { dir: string; maxFileBytes: number }
  /** Whether a response to this request may be shown in a frame of our own origin (anything else is refused). */
  allowSameOriginFraming?: (request: { path: string; query: URLSearchParams }) => boolean
  /** The database is opened only once the application has been set up. */
  database: {
    isReady: () => boolean
    open: () => void
    migrate: () => void
    close: () => void
  }
  /** Registers every route of the application. */
  routes: (app: FastifyInstance) => Promise<void>
  /** Registers the built front-ends; called in production only, after the routes. */
  frontends?: (app: FastifyInstance) => Promise<void>
  /** Takes the lock that keeps a second instance away from the data directory; returns the release. */
  acquireLock: () => () => void
  /** Work that runs only while the application is set up. */
  backgroundServices?: { start: () => void; stop: () => void }
  /** Called when the process is asked to stop, before the server drains (close event streams, say). */
  stopIntake?: () => void
  /** Name used in the line logged when the server is up. */
  logName?: string
  port?: number
}

/**
 * Builds the HTTP application the Better products share: logging that hides credentials, proxy trust, CORS and a
 * cross-site guard, cookies, JWT sessions, rate limiting, uploads, security headers, the database once set up, and the
 * application's routes. `run` then takes the lock, listens, and wires the shutdown that closes everything in order.
 */
export async function createBetterApp(options: BetterAppOptions) {
  const redaction = { queryParams: options.redactQueryParams, pathTokenPrefixes: options.redactPathTokenPrefixes }

  const app = Fastify({
    logger: {
      level: 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: redactUrl(req.url, redaction),
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
  options.validate?.()
  await app.register(jwt, {
    secret: jwtSecret,
    sign: { expiresIn: JWT_EXPIRES_IN },
  })

  // Rate limiting (applied per-route where needed); IPv6 clients are counted per /64
  await app.register(rateLimit, { global: false, keyGenerator: (req) => rateLimitKey(req.ip) })

  // Multipart (file uploads)
  await app.register(multipart, {
    limits: { fileSize: options.uploads.maxFileBytes },
  })

  // Serve uploaded files
  if (!fs.existsSync(options.uploads.dir)) {
    fs.mkdirSync(options.uploads.dir, { recursive: true })
  }
  await app.register(staticFiles, {
    root: options.uploads.dir,
    prefix: '/uploads/',
    decorateReply: false,
  })

  // Security headers
  app.addHook('onSend', (req: FastifyRequest, reply, _payload, done) => {
    const [requestPath = '', query = ''] = req.url.split('?', 2)
    const framed = options.allowSameOriginFraming?.({ path: requestPath, query: new URLSearchParams(query) }) ?? false
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', framed ? 'SAMEORIGIN' : 'DENY')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    reply.header('Cross-Origin-Opener-Policy', 'same-origin')
    reply.header('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      framed ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
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
  if (options.database.isReady()) {
    options.database.open()
    options.database.migrate()
  }

  await options.routes(app)

  // Serve built frontend apps in production
  if (process.env['NODE_ENV'] === 'production') await options.frontends?.(app)

  /** Takes the lock, listens, and makes the process stop cleanly on SIGTERM and SIGINT. */
  async function run(): Promise<void> {
    const port = options.port ?? Number(process.env['PORT'] ?? 3000)
    const releaseLock = options.acquireLock()
    const runtime = createRuntimeShutdown({
      stopIntake: () => {
        options.stopIntake?.()
        options.backgroundServices?.stop()
      },
      closeServer: () => app.close(),
      releaseResources: () => {
        options.database.close()
        releaseLock()
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
    console.log(`✓ ${options.logName ?? 'API'} running on http://localhost:${port}`)

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, runtime.shutdown)
    }

    if (options.database.isReady()) options.backgroundServices?.start()
  }

  return { app, run }
}

export type BetterApp = Awaited<ReturnType<typeof createBetterApp>>
