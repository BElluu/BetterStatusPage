import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, gte, like, lte, sql } from 'drizzle-orm'
import type { AuditAction } from '@better-kit/contracts'
import type { SqliteDatabase } from '@better-kit/db'
import { parsePagination } from './pagination.js'
import { auditLog } from './tables.js'

/** Keys whose values never reach the log. */
export const DEFAULT_SENSITIVE_KEYS = /(password|secret|token|authorization|cookie|credential|vaultconfig|encryptedvalue|recoverycode)/i

export interface Actor {
  userId: number
  userEmail: string
}

export interface AuditOptions {
  /** The application's database handle. It is used lazily, so it may be opened after this is created. */
  db: SqliteDatabase
  /** Keys whose values are replaced by `[redacted]`. */
  sensitiveKeys?: RegExp
}

/** Audit log: writing entries, redacted diffs and the admin read route. All state is in the returned closure. */
export function createAudit(options: AuditOptions) {
  const { db } = options
  const sensitiveKey = options.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS

  function redactValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactValue)
    if (value && typeof value === 'object') return redactObj(value as Record<string, unknown>)
    return value
  }

  /** Mask sensitive keys in a flat object. */
  function redactObj(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sensitiveKey.test(k) ? '[redacted]' : redactValue(v)
    }
    return out
  }

  /**
   * Compute a field-level diff between two flat objects.
   * Only changed keys are included. Sensitive keys are masked.
   */
  function diffObjects(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Record<string, { from: unknown; to: unknown }> {
    const diff: Record<string, { from: unknown; to: unknown }> = {}
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        diff[key] = {
          from: sensitiveKey.test(key) ? '[redacted]' : redactValue(before[key]),
          to: sensitiveKey.test(key) ? '[redacted]' : redactValue(after[key]),
        }
      }
    }
    return diff
  }

  /** Snapshot of an entity for a create/delete entry. Sensitive keys masked. */
  function snapshot(obj: Record<string, unknown>): Record<string, unknown> {
    return redactObj(obj)
  }

  /** Audit actor for an authenticated identity; an API token appears under its own name, with user id 0 (no user). */
  function actor(identity: { userId: number; email: string }): Actor {
    return { userId: identity.userId, userEmail: identity.email }
  }

  /**
   * Write an audit log entry. Failures are swallowed so they never break the
   * primary operation.
   */
  async function write(
    who: Actor,
    action: AuditAction,
    entityType: string,
    entityId: number | string | null,
    entityName: string,
    diff?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.insert(auditLog).values({
        userId: who.userId,
        userEmail: who.userEmail,
        action,
        entityType,
        entityId: entityId !== null ? String(entityId) : null,
        entityName,
        diff: diff ? JSON.stringify(redactObj(diff)) : null,
        timestamp: Date.now(),
      })
    } catch (err) {
      console.error('[audit] write failed:', err)
    }
  }

  /** `GET /`: the log, newest first, filterable. Register it under the prefix and the guards of your choice. */
  const routes: FastifyPluginAsync = async (app) => {
    app.get<{
      Querystring: {
        page?: string
        limit?: string
        userEmail?: string
        entityType?: string
        action?: string
        from?: string   // unix ms
        to?: string     // unix ms
      }
    }>('/', async (req) => {
      const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 })

      const conditions = []
      if (req.query.userEmail) conditions.push(like(auditLog.userEmail, `%${req.query.userEmail}%`))
      if (req.query.entityType) conditions.push(eq(auditLog.entityType, req.query.entityType))
      if (req.query.action)     conditions.push(eq(auditLog.action, req.query.action))
      if (req.query.from)       conditions.push(gte(auditLog.timestamp, Number(req.query.from)))
      if (req.query.to)         conditions.push(lte(auditLog.timestamp, Number(req.query.to)))

      const where = conditions.length > 0 ? and(...conditions) : undefined

      const [entries, countResult] = await Promise.all([
        db.select().from(auditLog)
          .where(where)
          .orderBy(desc(auditLog.timestamp))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)` }).from(auditLog).where(where),
      ])

      const total = countResult[0]?.count ?? 0
      return {
        entries: entries.map((e) => ({ ...e, diff: e.diff ? JSON.parse(e.diff) : null })),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      }
    })
  }

  return { write, diffObjects, snapshot, actor, routes }
}

export type Audit = ReturnType<typeof createAudit>
