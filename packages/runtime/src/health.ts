import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import type { SqliteDatabase } from '@better-kit/db'
import type { LatestRelease } from './updateCheck.js'

/** `GET /health` (the process is up) and `GET /ready` (set up and the database answers), for load balancers and probes. */
export function createHealthRoutes(options: { db: SqliteDatabase; isSetupComplete: () => boolean }) {
  return async function healthRoutes(app: FastifyInstance) {
    app.get('/health', async () => ({ status: 'ok' }))

    app.get('/ready', async (_req, reply) => {
      if (!options.isSetupComplete()) {
        return reply.code(503).send({ status: 'not_ready' })
      }
      try {
        await options.db.run(sql`SELECT 1`)
        return { status: 'ready' }
      } catch {
        return reply.code(503).send({ status: 'not_ready' })
      }
    })
  }
}

export type ComponentStatus = 'ok' | 'attention' | 'error' | 'disabled'

/** One part of the system the report describes. Its `status` is what the overall status is decided by. */
export type HealthSection = { status: ComponentStatus } & Record<string, unknown>

export interface HealthContributor {
  /** The key of the section in the report. */
  key: string
  /**
   * When true, a section in the `error` status makes the whole report `degraded`; otherwise it is only shown.
   */
  critical: boolean
  /** Builds the section. Called after the database was probed; `now` is the time the report is made for. */
  collect(context: { now: number; databaseOk: boolean }): Promise<HealthSection> | HealthSection
}

export interface SystemHealthReport {
  status: 'healthy' | 'degraded'
  generatedAt: number
  application: {
    status: 'ok'
    version: string
    uptimeSeconds: number
    /** A newer published release, or null when up to date, unknown or the update check is off. */
    update: LatestRelease | null
  }
  database: {
    status: 'ok' | 'error'
    responseMs: number | null
  }
  /** The sections of the contributors, by key. */
  [section: string]: unknown
}

/**
 * The protected report of how the instance is doing: the process, the database, and one section per contributor the
 * application registers (a scheduler, a queue, backups, ...). Exposes state, not raw errors.
 */
export function createSystemHealth(options: {
  db: SqliteDatabase
  version: () => string
  update: () => LatestRelease | null
  contributors: readonly HealthContributor[]
}) {
  async function getSystemHealthReport(now = Date.now()): Promise<SystemHealthReport> {
    const databaseStartedAt = Date.now()
    let database: SystemHealthReport['database'] = { status: 'error', responseMs: null }
    try {
      await options.db.run(sql`SELECT 1`)
      database = { status: 'ok', responseMs: Date.now() - databaseStartedAt }
    } catch {
      // The protected report deliberately exposes state, not raw database errors.
    }

    const sections: Record<string, HealthSection> = {}
    for (const contributor of options.contributors) {
      sections[contributor.key] = await contributor.collect({ now, databaseOk: database.status === 'ok' })
    }
    const failing = options.contributors.some((contributor) => contributor.critical && sections[contributor.key]!.status === 'error')

    return {
      status: database.status === 'ok' && !failing ? 'healthy' : 'degraded',
      generatedAt: now,
      application: { status: 'ok', version: options.version(), uptimeSeconds: Math.floor(process.uptime()), update: options.update() },
      database,
      ...sections,
    }
  }

  /** Routes: the report at `/` and, at `/update`, only the running version and a newer release, if any. */
  async function systemHealthRoutes(app: FastifyInstance) {
    app.get('/', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store')
      return getSystemHealthReport()
    })

    /** Cheap enough for a dashboard to ask on every visit. */
    app.get('/update', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store')
      return { version: options.version(), update: options.update() }
    })
  }

  return { getSystemHealthReport, systemHealthRoutes }
}
